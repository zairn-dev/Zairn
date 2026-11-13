// Reader for Google GnssLogger v3 text logs (Fix records only).
//
// Columns are taken from the "# Fix,..." header, so field order changes in
// later GnssLogger versions do not break parsing. MockLocation is the
// Android Location.isMock() flag, i.e. the ground truth for mock sessions.

import { readFileSync } from 'node:fs';

/** @returns {{device: string, fixes: {provider, lat, lon, accuracy, t, mock, satellites, meanCn0}[]}} */
export function readGnssLogger(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const header = lines.find((l) => l.startsWith('# Fix,'));
  if (!header) throw new Error(`${path}: no "# Fix" header`);
  const col = Object.fromEntries(header.slice(2).split(',').map((name, i) => [name.trim(), i]));
  const version = lines.find((l) => l.startsWith('# Version:')) ?? '';
  const device = /Model: (.+?) GNSS/.exec(version)?.[1] ?? 'unknown';
  const fixes = [];
  for (const l of lines) {
    if (!l.startsWith('Fix,')) continue;
    const c = l.split(',');
    const extra = c[col.ExtraKeyValuePairs] ?? '';
    fixes.push({
      provider: c[col.Provider],
      lat: Number(c[col.LatitudeDegrees]),
      lon: Number(c[col.LongitudeDegrees]),
      accuracy: Number(c[col.AccuracyMeters]),
      t: Number(c[col.UnixTimeMillis]),
      mock: ['1', 'true'].includes((c[col.MockLocation] ?? '').trim().toLowerCase()),
      satellites: Number(/satellites=(\d+)/.exec(extra)?.[1] ?? NaN),
      meanCn0: Number(/meanCn0=(\d+)/.exec(extra)?.[1] ?? NaN),
    });
  }
  fixes.sort((a, b) => a.t - b.t);
  return { device, fixes };
}

/** One provider's fixes as scorer points, dropping repeated or out-of-order timestamps. */
export function providerStream(fixes, provider) {
  const out = [];
  let dropped = 0;
  for (const f of fixes) {
    if (f.provider !== provider) continue;
    if (out.length && f.t <= out.at(-1).t) { dropped++; continue; }
    out.push({ lat: f.lat, lon: f.lon, accuracy: f.accuracy, t: f.t, timestamp: new Date(f.t).toISOString(), mock: f.mock, satellites: f.satellites });
  }
  return { points: out, dropped };
}
