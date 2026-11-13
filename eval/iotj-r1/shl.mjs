// Loader for the SHL Preview dataset (Sussex-Huawei Locomotion and
// Transportation). Non-profit research licence; kept outside the repository.
//
// Layout: <root>/SHLDataset_preview_v1/User*/<day>/{Hand,Torso,Hips,Bag}_Location.txt
// and Label.txt (100 Hz; the second column is the coarse transport mode).

import { readFileSync, readdirSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export const SHL_DEFAULT_ROOT = 'F:/data/shl/extracted';
export const MODES = ['null', 'still', 'walk', 'run', 'bike', 'car', 'bus', 'train', 'subway'];

/** Keep only the change points of the coarse label. */
async function readLabels(path) {
  const changes = [];
  let last = -1;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const sp = line.indexOf(' ');
    const sp2 = line.indexOf(' ', sp + 1);
    const t = Number(line.slice(0, sp));
    const label = Number(line.slice(sp + 1, sp2 === -1 ? undefined : sp2));
    if (label !== last) { changes.push([t, label]); last = label; }
  }
  return changes;
}

export function modeAt(changes, t) {
  if (!changes.length || t < changes[0][0]) return 'null';
  let lo = 0, hi = changes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (changes[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return MODES[changes[lo][1]] ?? 'null';
}

// Location.txt columns: timestamp [ms], ignore, ignore, accuracy [m], lat, lon, alt.
function readFixes(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const c = line.trim().split(/\s+/).map(Number);
    return { t: c[0], accuracy: c[3], lat: c[4], lon: c[5], timestamp: new Date(c[0]).toISOString() };
  }).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && !(f.lat === 0 && f.lon === 0));
}

/** Yields one record per (user, day, phone position). */
export async function* loadShl(root = SHL_DEFAULT_ROOT) {
  const base = join(root, 'SHLDataset_preview_v1');
  for (const user of readdirSync(base).filter((d) => /^User\d+$/.test(d)).sort()) {
    for (const day of readdirSync(join(base, user)).sort()) {
      const dir = join(base, user, day);
      const labelPath = join(dir, 'Label.txt');
      if (!existsSync(labelPath)) continue;
      const labels = await readLabels(labelPath);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('_Location.txt')).sort()) {
        yield { user, day, position: file.replace('_Location.txt', ''), fixes: readFixes(join(dir, file)), labels };
      }
    }
  }
}
