/**
 * Paper ① — Pillar B: convergent/discriminant validity of GPS-derived
 * social-presence proxies against the StudentLife EMA HUMAN criterion.
 *
 * Constructs a system might display from a trace:
 *   K4 reachable/available, K3 sociable  ->  proxied by being out / mobile.
 * Human criterion (EMA):
 *   Social "How many people did you contact YESTERDAY" [1..6]  (=> lag 1 day)
 *   discriminant confounds: Sleep hours, Stress level (same day).
 *
 * HONESTY: EMA is sparse, per-day, self-reported -> a weak criterion. The
 * point is exactly to quantify HOW WEAK the convergent validity is: if a
 * GPS "out-and-about" proxy barely tracks self-reported sociability, then a
 * system cannot validly claim "reachable/social" from the trace. Spearman r.
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DS = 'F:/dataset';
const GPS = join(DS, 'sensing/gps');
const EMA = join(DS, 'EMA/response');
const RD = join(import.meta.dirname, 'results');
const EST = 5 * 3600;                       // crude EST day alignment
const dayIdx = t => Math.floor((t - EST) / 86400);

function hav(a, b, c, d) {
  const R = 6371000, p = Math.PI / 180;
  const x = Math.min(1, Math.sin((c-a)*p/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function spearman(xs, ys) {
  const n = xs.length; if (n < 5) return { r: null, n };
  const rank = a => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length); let i = 0;
    while (i < idx.length) { let j = i; while (j+1 < idx.length && idx[j+1][0] === idx[i][0]) j++; const avg = (i+j)/2 + 1; for (let k=i;k<=j;k++) r[idx[k][1]] = avg; i = j+1; }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((s,v)=>s+v,0)/n, my = ry.reduce((s,v)=>s+v,0)/n;
  let num=0, dx=0, dy=0; for (let i=0;i<n;i++){ const a=rx[i]-mx, b=ry[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
  return { r: +(num/Math.sqrt(dx*dy)).toFixed(3), n };
}

// per-user (within-person) Spearman, then aggregate -> guards vs pooled/Simpson confound
function perUserStat(rows, xk, yk, minDays = 8) {
  const byU = {};
  for (const r of rows) { if (r[xk] == null || r[yk] == null) continue; (byU[r.uid] ??= []).push([r[xk], r[yk]]); }
  const rs = []; let pos = 0;
  for (const u in byU) {
    const xy = byU[u]; if (xy.length < minDays) continue;
    const s = spearman(xy.map(p => p[0]), xy.map(p => p[1]));
    if (s.r != null) { rs.push(s.r); if (s.r > 0) pos++; }
  }
  rs.sort((a, b) => a - b);
  return rs.length ? { users: rs.length, medianR: +rs[rs.length >> 1].toFixed(3), pctPositive: +(100 * pos / rs.length).toFixed(0), iqr: [+rs[Math.floor(rs.length*0.25)].toFixed(2), +rs[Math.floor(rs.length*0.75)].toFixed(2)] } : { users: 0 };
}

// multivariate OLS R^2 ceiling (best linear trace model) via normal equations
function olsR2(rows, xks, yk) {
  const data = rows.filter(r => r[yk] != null && xks.every(k => r[k] != null));
  const n = data.length, p = xks.length + 1;
  if (n < p + 5) return { r2: null, n };
  const X = data.map(r => [1, ...xks.map(k => r[k])]), y = data.map(r => r[yk]);
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { A[a][p] += X[i][a] * y[i]; for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b]; }
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; const d = A[c][c]; if (Math.abs(d) < 1e-12) return { r2: null, n };
    for (let j = c; j <= p; j++) A[c][j] /= d;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c]; for (let j = c; j <= p; j++) A[r][j] -= f * A[c][j]; }
  }
  const beta = A.map(row => row[p]);
  const my = y.reduce((s, v) => s + v, 0) / n; let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { const pred = X[i].reduce((s, v, j) => s + v * beta[j], 0); ssr += (y[i] - pred) ** 2; sst += (y[i] - my) ** 2; }
  return { r2: +(1 - ssr / sst).toFixed(3), n };
}

async function emaPerDay(type, qid, lag = 0) {
  const map = {};
  let files = [];
  try { files = (await readdir(join(EMA, type))).filter(f => /_u\d+\.json$/.test(f)); } catch { return map; }
  for (const f of files) {
    const uid = f.match(/_u(\d+)\.json$/)[1];
    const arr = JSON.parse(await readFile(join(EMA, type, f), 'utf-8'));
    for (const r of arr) {
      if (!(qid in r)) continue;
      const v = parseFloat(r[qid]); if (!isFinite(v)) continue;
      const d = dayIdx(r.resp_time) - lag;
      (map[uid] ??= {}); (map[uid][d] ??= []).push(v);
    }
  }
  const out = {};
  for (const u in map) { out[u] = {}; for (const d in map[u]) { const a = map[u][d]; out[u][d] = a.reduce((s,v)=>s+v,0)/a.length; } }
  return out;
}

async function main() {
  const evalRes = JSON.parse(await readFile(join(import.meta.dirname, 'results/studentlife-eval.json'), 'utf-8'));
  const home = {}; for (const u of evalRes.userResults) home[u.userId] = u.home;

  const social = await emaPerDay('Social', 'number', 1);   // "yesterday" -> lag 1
  const sleep  = await emaPerDay('Sleep',  'hour',  0);
  const stress = await emaPerDay('Stress', 'level', 0);

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
      });
    }
  }

  const wS = rows.filter(r => r.social != null);
  const conv = {
    awayFrac_x_social:   spearman(wS.map(r=>r.awayFrac),   wS.map(r=>r.social)),
    nCells_x_social:     spearman(wS.map(r=>r.nCells),     wS.map(r=>r.social)),
    movingFrac_x_social: spearman(wS.map(r=>r.movingFrac), wS.map(r=>r.social)),
  };
  const wSl = rows.filter(r=>r.sleep!=null), wSt = rows.filter(r=>r.stress!=null);
  const disc = {
    awayFrac_x_sleep:  spearman(wSl.map(r=>r.awayFrac), wSl.map(r=>r.sleep)),
    awayFrac_x_stress: spearman(wSt.map(r=>r.awayFrac), wSt.map(r=>r.stress)),
  };

  const perUser = {
    movingFrac_x_social: perUserStat(rows, 'movingFrac', 'social'),
    nCells_x_social:     perUserStat(rows, 'nCells', 'social'),
    awayFrac_x_social:   perUserStat(rows, 'awayFrac', 'social'),
  };
  const multivariate = { social_R2_all_proxies: olsR2(rows, ['awayFrac', 'nCells', 'movingFrac'], 'social') };

  const out = {
    _construct: 'K3/K4 social-presence convergent/discriminant validity vs StudentLife EMA',
    _note: 'GPS proxies vs self-reported #people-contacted (Social, lag1). Pooled Spearman + per-user within-person Spearman (median r, %positive, IQR) + multivariate OLS R2 ceiling (best linear trace model). Discriminant = sleep/stress. EMA sparse = weak human criterion (honesty).',
    nUsers: gpsFiles.length, nUserDays: rows.length, nWithSocial: wS.length,
    convergent_pooled: conv, discriminant_pooled: disc,
    convergent_perUser: perUser, multivariate_ceiling: multivariate,
  };
  await writeFile(join(RD, 'ema-construct-validity.json'), JSON.stringify(out, null, 2));

  console.log(`user-days: ${rows.length}, with Social EMA: ${wS.length}`);
  console.log('\nCONVERGENT (pooled) — GPS proxy vs #people contacted:');
  for (const k in conv) console.log('  ' + k.padEnd(22), 'r=' + conv[k].r, '(n=' + conv[k].n + ')');
  console.log('DISCRIMINANT (pooled) — away-frac vs confounds (want ~0):');
  for (const k in disc) console.log('  ' + k.padEnd(22), 'r=' + disc[k].r, '(n=' + disc[k].n + ')');
  console.log('CONVERGENT (per-user / within-person):');
  for (const k in perUser) console.log('  ' + k.padEnd(22), JSON.stringify(perUser[k]));
  console.log('MULTIVARIATE ceiling — social ~ all 3 proxies, OLS R2 =', multivariate.social_R2_all_proxies.r2, '(n=' + multivariate.social_R2_all_proxies.n + ')');
}
main().catch(e => { console.error(e); process.exit(1); });
