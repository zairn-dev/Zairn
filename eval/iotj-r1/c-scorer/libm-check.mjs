// Diagnostic for the last-bit signal differences between the JS and C
// scorers: exports every libm call the scorers make on the synthetic splits
// (sin / cos / sqrt / atan2 inside calculateDistance for S1, S3, S5, and the
// cos() of S4 / S4'), with V8's result, so libm_check can recompute them with
// the platform libm.
//
// Usage: node eval/iotj-r1/c-scorer/libm-check.mjs [outFile]
// Line format: fn arg1 [arg2] result   (doubles as IEEE-754 hex)

import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSplit } from '../data.mjs';
import { WINDOW_S } from '../revised-scorer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(process.argv[2] ?? join(here, 'build', 'libm-calls.txt'));
const out = createWriteStream(outFile);

const dv = new DataView(new ArrayBuffer(8));
const hx = (x) => (dv.setFloat64(0, x), dv.getBigUint64(0).toString(16).padStart(16, '0'));
const seen = new Set();
let lines = 0;
function emit(fn, args, r) {
  const line = `${fn} ${args.map(hx).join(' ')} ${hx(r)}`;
  if (seen.has(line)) return;
  seen.add(line);
  out.write(line + '\n');
  lines++;
}

// Mirrors calculateDistance in paper-scorer.mjs call by call.
function distance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  emit('sin', [dLat / 2], Math.sin(dLat / 2));
  emit('sin', [dLon / 2], Math.sin(dLon / 2));
  emit('cos', [lat1 * Math.PI / 180], Math.cos(lat1 * Math.PI / 180));
  emit('cos', [lat2 * Math.PI / 180], Math.cos(lat2 * Math.PI / 180));
  const a = Math.min(1, Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2));
  emit('sqrt', [a], Math.sqrt(a));
  emit('sqrt', [1 - a], Math.sqrt(1 - a));
  emit('atan2', [Math.sqrt(a), Math.sqrt(1 - a)], Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

for (const split of ['dev', 'val', 'test']) {
  for (const t of syntheticSplit(split)) {
    const c = t.current, h = t.history;
    if (h.length) distance(h[0].lat, h[0].lon, c.lat, c.lon); // S1
    const pts = [c, ...h.slice(0, 4)]; // S3
    if (h.length >= 2) for (let i = 0; i < pts.length - 1; i++) distance(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
    if (t.networkHint) distance(c.lat, c.lon, t.networkHint.lat, t.networkHint.lon); // S5
    const fx = t.recentFixes ?? [];
    if (fx.length >= 3) { // S4
      const meanLat = fx.reduce((s, f) => s + f.lat, 0) / fx.length;
      emit('cos', [(meanLat * Math.PI) / 180], Math.cos((meanLat * Math.PI) / 180));
    }
    const tNow = Date.parse(c.timestamp); // S4'
    const win = fx.filter((f) => { const dt = (tNow - Date.parse(f.timestamp)) / 1000; return dt >= 0 && dt <= WINDOW_S; });
    if (win.length >= 3) {
      const lat0 = win.reduce((s, f) => s + f.lat, 0) / win.length;
      emit('cos', [(lat0 * Math.PI) / 180], Math.cos((lat0 * Math.PI) / 180));
    }
  }
}
await new Promise((ok) => out.end(ok));
process.stderr.write(`${lines} distinct libm calls -> ${outFile}\n`);
