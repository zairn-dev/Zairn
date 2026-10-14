/**
 * Paper ① — Pillar B v2: panel-review fixes (2026-06-10).
 * Adds, over v1:
 *  1. CRITERION RELIABILITY (attenuation): same-day repeated-response
 *     test-retest of the Social EMA + within-person lag-1 autocorrelation
 *     (lower bound) → Spearman disattenuation sensitivity table.
 *  2. NEW CRITERIA: Activity EMA in-person social-time (other_working +
 *     other_relaxing, lag 0) = modality-matched co-presence criterion;
 *     Exercise EMA walk-duration (lag 0) = positive control / "teeth"
 *     discriminant (does moving-frac just measure movement?).
 *  3. STATISTICS: user-level cluster-bootstrap 95% CIs on all pooled
 *     Spearman r; within-user permutation p; BH-FDR over the convergent
 *     family; equivalence check (|r|<0.10) for discriminants.
 *  4. MULTIVARIATE: OLS R² (robustness), rank-OLS R² (ordinal-safe),
 *     within-person-centered R² (fixed-effects analogue).
 * (Full CLMM left as optional polish — Spearman/rank machinery is the
 *  ordinal-appropriate primary here.)
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DS = 'F:/dataset';
const GPS = join(DS, 'sensing/gps');
const EMA = join(DS, 'EMA/response');
const RD = join(import.meta.dirname, 'results');
const EST = 5 * 3600;
const dayIdx = t => Math.floor((t - EST) / 86400);
const B = 1000;

// deterministic RNG (reproducibility — no Math.random)
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hav(a, b, c, d) {
  const R = 6371000, p = Math.PI / 180;
  const x = Math.min(1, Math.sin((c-a)*p/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j+1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1;
  }
  return r;
}
function pearson(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const mx = xs.reduce((s,v)=>s+v,0)/n, my = ys.reduce((s,v)=>s+v,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ const a=xs[i]-mx, b=ys[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
  return dx && dy ? num/Math.sqrt(dx*dy) : null;
}
const spearman = (xs, ys) => xs.length < 5 ? null : pearson(rank(xs), rank(ys));

// pooled spearman over rows + user-cluster bootstrap CI + within-user permutation p
function pooledStat(rows, xk, yk, seed) {
  const data = rows.filter(r => r[xk] != null && r[yk] != null);
  const n = data.length; if (n < 10) return { r: null, n };
  const r = +spearman(data.map(d => d[xk]), data.map(d => d[yk])).toFixed(3);
  const byU = {};
  for (const d of data) (byU[d.uid] ??= []).push(d);
  const uids = Object.keys(byU);
  // cluster bootstrap (resample users)
  const rng = mulberry32(seed);
  const boots = [];
  for (let b = 0; b < B; b++) {
    const xs = [], ys = [];
    for (let i = 0; i < uids.length; i++) {
      const u = byU[uids[Math.floor(rng() * uids.length)]];
      for (const d of u) { xs.push(d[xk]); ys.push(d[yk]); }
    }
    const rb = spearman(xs, ys); if (rb != null) boots.push(rb);
  }
  boots.sort((a, b2) => a - b2);
  const ci = [+boots[Math.floor(boots.length * 0.025)].toFixed(3), +boots[Math.floor(boots.length * 0.975)].toFixed(3)];
  // within-user permutation of the criterion
  const rng2 = mulberry32(seed + 1);
  let ge = 0;
  for (let b = 0; b < B; b++) {
    const xs = [], ys = [];
    for (const u of uids) {
      const d = byU[u];
      const perm = d.map(v => v[yk]);
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rng2() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      for (let i = 0; i < d.length; i++) { xs.push(d[i][xk]); ys.push(perm[i]); }
    }
    if (Math.abs(spearman(xs, ys)) >= Math.abs(r)) ge++;
  }
  const p = +((1 + ge) / (B + 1)).toFixed(4);
  return { r, n, users: uids.length, ci95: ci, permP: p };
}

function bhFDR(tests) { // tests: [{key, p}] → adds q
  const sorted = [...tests].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const q = Math.min(prev, sorted[i].p * m / (i + 1));
    sorted[i].q = +q.toFixed(4); prev = q;
  }
  return tests.map(t => sorted.find(s => s.key === t.key).q);
}

function perUserStat(rows, xk, yk, minDays = 8) {
  const byU = {};
  for (const r of rows) { if (r[xk] == null || r[yk] == null) continue; (byU[r.uid] ??= []).push([r[xk], r[yk]]); }
  const rs = []; let pos = 0;
  for (const u in byU) {
    const xy = byU[u]; if (xy.length < minDays) continue;
    const s = spearman(xy.map(p => p[0]), xy.map(p => p[1]));
    if (s != null) { rs.push(s); if (s > 0) pos++; }
  }
  rs.sort((a, b) => a - b);
  if (!rs.length) return { users: 0 };
  // two-sided sign test (normal approx) on #positive
  const k = pos, nn = rs.length;
  const z = (k - nn / 2) / Math.sqrt(nn / 4);
  const signP = +(2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))).toFixed(4);
  return {
    users: nn, medianR: +rs[nn >> 1].toFixed(3), pctPositive: +(100 * k / nn).toFixed(0),
    iqr: [+rs[Math.floor(nn * 0.25)].toFixed(2), +rs[Math.floor(nn * 0.75)].toFixed(2)], signTestP: signP,
  };
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return y;
}

function olsR2(X, y) { // X: rows of regressors (no intercept col), y: outcome
  const n = y.length, p = X[0].length + 1;
  if (n < p + 5) return null;
  const Xi = X.map(r => [1, ...r]);
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { A[a][p] += Xi[i][a] * y[i]; for (let b = 0; b < p; b++) A[a][b] += Xi[i][a] * Xi[i][b]; }
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; const d = A[c][c]; if (Math.abs(d) < 1e-12) return null;
    for (let j = c; j <= p; j++) A[c][j] /= d;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c]; for (let j = c; j <= p; j++) A[r][j] -= f * A[c][j]; }
  }
  const beta = A.map(row => row[p]);
  const my = y.reduce((s, v) => s + v, 0) / n; let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { const pred = Xi[i].reduce((s, v, j) => s + v * beta[j], 0); ssr += (y[i] - pred) ** 2; sst += (y[i] - my) ** 2; }
  return +(1 - ssr / sst).toFixed(3);
}

// raw per-day EMA values (arrays kept for reliability estimation)
async function emaRaw(type, valueOf, lag = 0) {
  const map = {};
  let files = [];
  try { files = (await readdir(join(EMA, type))).filter(f => /_u\d+\.json$/.test(f)); } catch { return map; }
  for (const f of files) {
    const uid = f.match(/_u(\d+)\.json$/)[1];
    const arr = JSON.parse(await readFile(join(EMA, type, f), 'utf-8'));
    for (const r of arr) {
      const v = valueOf(r); if (v == null || !isFinite(v)) continue;
      const d = dayIdx(r.resp_time) - lag;
      (map[uid] ??= {}); (map[uid][d] ??= []).push(v);
    }
  }
  return map;
}
const dayMean = raw => {
  const out = {};
  for (const u in raw) { out[u] = {}; for (const d in raw[u]) { const a = raw[u][d]; out[u][d] = a.reduce((s,v)=>s+v,0)/a.length; } }
  return out;
};

async function main() {
  const evalRes = JSON.parse(await readFile(join(import.meta.dirname, 'results/studentlife-eval.json'), 'utf-8'));
  const home = {}; for (const u of evalRes.userResults) home[u.userId] = u.home;

  const qid = id => r => { const v = parseFloat(r[id]); return isFinite(v) ? v : null; };
  const socialRaw = await emaRaw('Social', qid('number'), 1);                 // "yesterday" → lag 1
  const social = dayMean(socialRaw);
  const sleep  = dayMean(await emaRaw('Sleep',  qid('hour'),  0));
  const stress = dayMean(await emaRaw('Stress', qid('level'), 0));
  // in-person social time today: with-others working + relaxing (each [1..5] = % of time)
  const activitySocial = dayMean(await emaRaw('Activity', r => {
    const a = parseFloat(r.other_working), b = parseFloat(r.other_relaxing);
    return isFinite(a) && isFinite(b) ? a + b : null;
  }, 0));
  const walk = dayMean(await emaRaw('Exercise', qid('walk'), 0));             // walked today [1..5]

  // GPS per-day proxies (identical to v1)
  const rows = [];
  const gpsFiles = (await readdir(GPS)).filter(f => /gps_u\d+\.csv/i.test(f));
  for (const f of gpsFiles) {
    const uid = f.match(/u(\d+)\.csv/i)[1];
    const h = home[uid]; if (!h) continue;
    const lines = (await readFile(join(GPS, f), 'utf-8')).split(/\r?\n/);
    const perDay = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 10) continue;
      const t = +c[0], lat = +c[4], lon = +c[5], trav = c[9];
      if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) continue;
      const d = dayIdx(t);
      (perDay[d] ??= { away: 0, tot: 0, cells: new Set(), moving: 0 });
      const pd = perDay[d]; pd.tot++;
      if (hav(lat, lon, h.lat, h.lon) > 200) pd.away++;
      if (trav && trav.includes('moving')) pd.moving++;
      pd.cells.add(Math.round(lat/0.005) + ',' + Math.round(lon/0.005));
    }
    for (const d in perDay) {
      const pd = perDay[d]; if (pd.tot < 5) continue;
      rows.push({
        uid, day: +d,
        awayFrac: pd.away / pd.tot, nCells: pd.cells.size, movingFrac: pd.moving / pd.tot,
        social: social[uid]?.[d], sleep: sleep[uid]?.[d], stress: stress[uid]?.[d],
        actSocial: activitySocial[uid]?.[d], walk: walk[uid]?.[d],
      });
    }
  }

  // ---- 1. criterion reliability of the Social EMA ----
  // (a) same-day repeated responses (both report the SAME "yesterday") → test-retest
  const p1 = [], p2 = [];
  for (const u in socialRaw) for (const d in socialRaw[u]) {
    const a = socialRaw[u][d];
    if (a.length >= 2) { p1.push(a[0]); p2.push(a[1]); }
  }
  const rTestRetest = p1.length >= 5 ? +spearman(p1, p2).toFixed(3) : null;
  // (b) within-person lag-1 autocorrelation (= stability × reliability → LOWER bound on r_yy)
  const l1 = [], l2 = [];
  for (const u in social) for (const d in social[u]) {
    const nx = social[u][+d + 1];
    if (nx != null) { l1.push(social[u][d]); l2.push(nx); }
  }
  const rLag1 = l1.length >= 5 ? +spearman(l1, l2).toFixed(3) : null;

  // ---- 2. pooled correlation matrix with CIs / permutation p ----
  const PROXIES = ['awayFrac', 'nCells', 'movingFrac'];
  const CRITERIA = [
    ['social', 'convergent (#people contacted, mixed-modality, lag1)'],
    ['actSocial', 'convergent (in-person social time today, modality-matched)'],
    ['walk', 'positive control (walking duration today = movement)'],
    ['sleep', 'discriminant'], ['stress', 'discriminant'],
  ];
  const matrix = {};
  let seed = 42;
  for (const [ck] of CRITERIA) { matrix[ck] = {}; for (const xk of PROXIES) matrix[ck][xk] = pooledStat(rows, xk, ck, seed += 7); }

  // BH-FDR over the 6 convergent tests
  const convTests = [];
  for (const ck of ['social', 'actSocial']) for (const xk of PROXIES) convTests.push({ key: ck + ':' + xk, p: matrix[ck][xk].permP });
  const qs = bhFDR(convTests);
  convTests.forEach((t, i) => { const [ck, xk] = t.key.split(':'); matrix[ck][xk].fdrQ = qs[i]; });
  // equivalence check for discriminants (|r| < 0.10 with CI inside bounds)
  for (const ck of ['sleep', 'stress']) for (const xk of PROXIES) {
    const m = matrix[ck][xk];
    if (m.ci95) m.equivWithin01 = m.ci95[0] > -0.1 && m.ci95[1] < 0.1;
  }

  // ---- 3. per-user (within-person) ----
  const perUser = {};
  for (const ck of ['social', 'actSocial']) {
    perUser[ck] = {};
    for (const xk of PROXIES) perUser[ck][xk] = perUserStat(rows, xk, ck);
  }

  // ---- 4. multivariate ceilings (social criterion) ----
  const wS = rows.filter(r => r.social != null && PROXIES.every(k => r[k] != null));
  const X = wS.map(r => PROXIES.map(k => r[k])), y = wS.map(r => r.social);
  const r2ols = olsR2(X, y);
  // ordinal-safe: regress rank(y) on rank(x)
  const Xr = PROXIES.map((k, j) => rank(X.map(row => row[j])));
  const r2rank = olsR2(X.map((_, i) => PROXIES.map((k, j) => Xr[j][i])), rank(y));
  // within-person centered (fixed-effects analogue)
  const mu = {}, cnt = {}, muY = {};
  for (const r of wS) {
    (mu[r.uid] ??= PROXIES.map(() => 0)); (muY[r.uid] ??= 0); (cnt[r.uid] ??= 0);
    PROXIES.forEach((k, j) => mu[r.uid][j] += r[k]); muY[r.uid] += r.social; cnt[r.uid]++;
  }
  for (const u in mu) { mu[u] = mu[u].map(v => v / cnt[u]); muY[u] /= cnt[u]; }
  const Xc = wS.map(r => PROXIES.map((k, j) => r[k] - mu[r.uid][j]));
  const yc = wS.map(r => r.social - muY[r.uid]);
  const r2within = olsR2(Xc, yc);

  // ---- 5. disattenuation sensitivity ----
  const rBest = matrix.social.movingFrac.r;
  const disatten = [];
  const ryyGrid = [rTestRetest, 0.4, 0.5, 0.6, 0.8].filter(v => v != null && v > 0.05);
  for (const ryy of [...new Set(ryyGrid)]) {
    disatten.push({
      assumed_ryy: ryy, source: ryy === rTestRetest ? 'EMPIRICAL same-day test-retest' : 'sensitivity',
      corrected_r_best: +(rBest / Math.sqrt(ryy)).toFixed(3),
      corrected_R2_ols: r2ols != null ? +(r2ols / ryy).toFixed(3) : null,
    });
  }

  const out = {
    _construct: 'K3/K4 social-presence validity vs StudentLife EMA — v2 (panel fixes)',
    _note: 'Adds criterion reliability + disattenuation, modality-matched in-person criterion (Activity EMA), walk positive control, cluster-bootstrap CIs, within-user permutation p, BH-FDR, equivalence checks, rank/within-person R². Deterministic seeds.',
    nUserDays: rows.length,
    criterionReliability: {
      social_sameDay_testRetest: { r: rTestRetest, nPairs: p1.length },
      social_lag1_autocorr_lowerBound: { r: rLag1, nPairs: l1.length },
    },
    pooledMatrix: matrix,
    perUser_withinPerson: perUser,
    multivariate: { ols_R2: r2ols, rank_R2: r2rank, withinPerson_R2: r2within, n: wS.length },
    disattenuation_bestProxy_movingFrac: disatten,
  };
  await writeFile(join(RD, 'ema-construct-validity-v2.json'), JSON.stringify(out, null, 2));

  console.log('user-days:', rows.length);
  console.log('\nCRITERION RELIABILITY (Social EMA):');
  console.log('  same-day test-retest r =', rTestRetest, `(n=${p1.length} pairs)`);
  console.log('  lag-1 autocorr (lower bound) r =', rLag1, `(n=${l1.length} pairs)`);
  console.log('\nPOOLED MATRIX  r [CI95] permP (q):');
  for (const [ck, label] of CRITERIA) {
    console.log(`  ${ck} — ${label}`);
    for (const xk of PROXIES) {
      const m = matrix[ck][xk];
      console.log(`    ${xk.padEnd(11)} r=${m.r} [${m.ci95}] p=${m.permP}${m.fdrQ != null ? ' q=' + m.fdrQ : ''}${m.equivWithin01 != null ? ' equiv±0.1=' + m.equivWithin01 : ''} (n=${m.n})`);
    }
  }
  console.log('\nPER-USER (within-person):');
  for (const ck in perUser) for (const xk in perUser[ck]) console.log(`  ${ck}×${xk}:`, JSON.stringify(perUser[ck][xk]));
  console.log('\nMULTIVARIATE: OLS R²=', r2ols, ' rank-R²=', r2rank, ' within-person R²=', r2within, `(n=${wS.length})`);
  console.log('\nDISATTENUATION (best proxy movingFrac × social):');
  for (const d of disatten) console.log(' ', JSON.stringify(d));
}
main().catch(e => { console.error(e); process.exit(1); });
