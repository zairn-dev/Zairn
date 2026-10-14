/**
 * Paper ① — Pillar B sensitivity panel (promised in Limitations §(4)).
 * Sweeps every single-point operationalization choice and reports how the
 * convergent correlations (GPS proxies × Social EMA) move:
 *   home radius 100/200/400 m; cell size 0.0025/0.005/0.01 deg;
 *   Social lag 0/1/2 days; day-alignment offset 4/5/6 h (DST bound);
 *   per-user minDays 8/10/14.
 * Point estimates only (the CIs live in ema-construct-validity-v2.mjs);
 * the question here is STABILITY of r across reasonable choices.
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DS = 'F:/dataset';
const GPS = join(DS, 'sensing/gps');
const EMA = join(DS, 'EMA/response');
const RD = join(import.meta.dirname, 'results');

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
function spearman(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((s,v)=>s+v,0)/n, my = ry.reduce((s,v)=>s+v,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ const a=rx[i]-mx, b=ry[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
  return dx && dy ? +(num/Math.sqrt(dx*dy)).toFixed(3) : null;
}
function perUserMedian(rows, xk, yk, minDays) {
  const byU = {};
  for (const r of rows) { if (r[xk] == null || r[yk] == null) continue; (byU[r.uid] ??= []).push([r[xk], r[yk]]); }
  const rs = [];
  for (const u in byU) {
    const xy = byU[u]; if (xy.length < minDays) continue;
    const s = spearman(xy.map(p => p[0]), xy.map(p => p[1]));
    if (s != null) rs.push(s);
  }
  rs.sort((a, b) => a - b);
  return rs.length ? { medianR: rs[rs.length >> 1], users: rs.length } : { medianR: null, users: 0 };
}

// load raw once
async function loadRaw() {
  const evalRes = JSON.parse(await readFile(join(import.meta.dirname, 'results/studentlife-eval.json'), 'utf-8'));
  const home = {}; for (const u of evalRes.userResults) home[u.userId] = u.home;
  const users = [];
  for (const f of (await readdir(GPS)).filter(f => /gps_u\d+\.csv/i.test(f))) {
    const uid = f.match(/u(\d+)\.csv/i)[1];
    if (!home[uid]) continue;
    const lines = (await readFile(join(GPS, f), 'utf-8')).split(/\r?\n/);
    const pts = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 10) continue;
      const t = +c[0], lat = +c[4], lon = +c[5];
      if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) continue;
      pts.push({ t, lat, lon, moving: c[9] && c[9].includes('moving') ? 1 : 0 });
    }
    users.push({ uid, home: home[uid], pts });
  }
  const socialByUser = {};
  for (const f of (await readdir(join(EMA, 'Social'))).filter(f => /_u\d+\.json$/.test(f))) {
    const uid = f.match(/_u(\d+)\.json$/)[1];
    const arr = JSON.parse(await readFile(join(EMA, 'Social', f), 'utf-8'));
    socialByUser[uid] = arr
      .map(r => ({ t: r.resp_time, v: parseFloat(r.number) }))
      .filter(r => isFinite(r.v));
  }
  return { users, socialByUser };
}

function buildRows({ users, socialByUser }, { radius, cell, lag, offsetH }) {
  const off = offsetH * 3600;
  const dayIdx = t => Math.floor((t - off) / 86400);
  const rows = [];
  for (const u of users) {
    const perDay = {};
    for (const p of u.pts) {
      const d = dayIdx(p.t);
      (perDay[d] ??= { away: 0, tot: 0, cells: new Set(), moving: 0 });
      const pd = perDay[d]; pd.tot++;
      if (hav(p.lat, p.lon, u.home.lat, u.home.lon) > radius) pd.away++;
      if (p.moving) pd.moving++;
      pd.cells.add(Math.round(p.lat / cell) + ',' + Math.round(p.lon / cell));
    }
    const social = {};
    for (const r of socialByUser[u.uid] ?? []) {
      const d = dayIdx(r.t) - lag;
      (social[d] ??= []).push(r.v);
    }
    for (const d in perDay) {
      const pd = perDay[d]; if (pd.tot < 5) continue;
      const sv = social[d];
      rows.push({
        uid: u.uid,
        awayFrac: pd.away / pd.tot, nCells: pd.cells.size, movingFrac: pd.moving / pd.tot,
        social: sv ? sv.reduce((s, v) => s + v, 0) / sv.length : null,
      });
    }
  }
  return rows;
}

async function main() {
  const raw = await loadRaw();
  const BASE = { radius: 200, cell: 0.005, lag: 1, offsetH: 5 };
  const CONFIGS = [
    { name: 'BASE (200m, 0.005°, lag1, EST-5h)', ...BASE },
    { name: 'radius 100m', ...BASE, radius: 100 },
    { name: 'radius 400m', ...BASE, radius: 400 },
    { name: 'cell 0.0025°', ...BASE, cell: 0.0025 },
    { name: 'cell 0.01°', ...BASE, cell: 0.01 },
    { name: 'lag 0 (same-day placebo)', ...BASE, lag: 0 },
    { name: 'lag 2 (placebo)', ...BASE, lag: 2 },
    { name: 'offset 4h (DST)', ...BASE, offsetH: 4 },
    { name: 'offset 6h', ...BASE, offsetH: 6 },
  ];
  const out = [];
  for (const cfg of CONFIGS) {
    const rows = buildRows(raw, cfg);
    const wS = rows.filter(r => r.social != null);
    const rec = { config: cfg.name, n: wS.length };
    for (const xk of ['awayFrac', 'nCells', 'movingFrac']) {
      rec['r_' + xk] = spearman(wS.map(r => r[xk]), wS.map(r => r.social));
    }
    rec.perUser_moving = perUserMedian(rows, 'movingFrac', 'social', 8);
    out.push(rec);
  }
  // minDays sweep on the BASE rows (per-user only)
  const baseRows = buildRows(raw, BASE);
  const minDaysSweep = [8, 10, 14].map(md => ({
    minDays: md, ...perUserMedian(baseRows, 'movingFrac', 'social', md),
  }));

  await writeFile(join(RD, 'ema-sensitivity-panel.json'), JSON.stringify({
    _note: 'Sensitivity of convergent Spearman r (GPS proxies × Social EMA) to operationalization choices. Point estimates; CIs in ema-construct-validity-v2.json. lag0/lag2 are placebo/robustness rows (item asks about YESTERDAY → lag1 is principled).',
    panel: out, minDaysSweep_perUser_movingFrac: minDaysSweep,
  }, null, 2));

  console.log('config'.padEnd(34), 'n'.padStart(5), 'away'.padStart(7), 'cells'.padStart(7), 'moving'.padStart(7), 'pu-median(users)');
  for (const r of out) {
    console.log(r.config.padEnd(34), String(r.n).padStart(5),
      String(r.r_awayFrac).padStart(7), String(r.r_nCells).padStart(7), String(r.r_movingFrac).padStart(7),
      `  ${r.perUser_moving.medianR} (${r.perUser_moving.users})`);
  }
  console.log('\nminDays sweep (per-user movingFrac × social):');
  for (const m of minDaysSweep) console.log(`  minDays=${m.minDays}: median r=${m.medianR} (${m.users} users)`);
}
main().catch(e => { console.error(e); process.exit(1); });
