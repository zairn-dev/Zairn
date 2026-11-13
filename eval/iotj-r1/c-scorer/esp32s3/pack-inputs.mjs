// Pack one split of export-inputs.mjs output (build/inputs-<split>.txt) into
// the fixed-size binary records the ESP32-S3 firmware reads from its "tsdata"
// partition. Same fields as ts_driver's text reader; doubles keep their exact
// bit patterns.
//
// Header (32 B): "TSR1", u32 version 1, u32 count, u32 record size, u32 split.
// Record (696 B, little-endian):
//     0 cur (lat lon acc f64, t i64)        32 hist[10] (same, newest first)
//   352 fixes[5]                           512 network lat lon acc
//   536 S1 S2 S2' S3 S4 S4' S5 (f64)       592 JS score x 10 (f64)
//   672 u8 nHist nFix hasNet sigPresent split scenario label 0
//   680 u8 mask x 10, 6 B padding
//
// Usage: node eval/iotj-r1/c-scorer/esp32s3/pack-inputs.mjs <dev|val|test>
// Writes c-scorer/build/esp32s3/inputs-<split>.bin.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const split = process.argv[2];
const SPLIT_ID = { dev: 0, val: 1, test: 2 };
if (!(split in SPLIT_ID)) throw new Error('usage: pack-inputs.mjs <dev|val|test>');

const HDR = 32, REC = 696, NCFG = 10, MAX_HIST = 10, MAX_FIX = 5;
const lines = readFileSync(join(here, '..', 'build', `inputs-${split}.txt`), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'));
const buf = new ArrayBuffer(HDR + lines.length * REC);
const dv = new DataView(buf);
const u8 = new Uint8Array(buf);
u8.set([0x54, 0x53, 0x52, 0x31], 0); // "TSR1"
dv.setUint32(4, 1, true);
dv.setUint32(8, lines.length, true);
dv.setUint32(12, REC, true);
dv.setUint32(16, SPLIT_ID[split], true);

const NAN_BITS = 0x7ff8000000000000n;
lines.forEach((line, i) => {
  const tok = line.trim().split(/\s+/);
  let k = 0;
  const base = HDR + i * REC;
  const int = () => Number(tok[k++]);
  const hex = (off) => {
    const s = tok[k++];
    dv.setBigUint64(base + off, s === '-' ? NAN_BITS : BigInt(`0x${s}`), true);
    return s !== '-';
  };
  const point = (off) => {
    hex(off); hex(off + 8); hex(off + 16);
    dv.setBigInt64(base + off + 24, BigInt(tok[k++]), true);
  };
  const sp = int(), scen = int(), label = int();
  point(0);
  const nHist = int();
  if (nHist > MAX_HIST) throw new Error(`line ${i}: history ${nHist}`);
  for (let j = 0; j < nHist; j++) point(32 + 32 * j);
  const nFix = int();
  if (nFix > MAX_FIX) throw new Error(`line ${i}: fixes ${nFix}`);
  for (let j = 0; j < nFix; j++) point(352 + 32 * j);
  const hasNet = int();
  if (hasNet) { hex(512); hex(520); hex(528); }
  let present = 0;
  for (let c = 0; c < 7; c++) if (hex(536 + 8 * c)) present |= 1 << c;
  for (let c = 0; c < NCFG; c++) {
    hex(592 + 8 * c);
    u8[base + 680 + c] = int();
  }
  if (k !== tok.length) throw new Error(`line ${i}: ${tok.length - k} tokens left over`);
  u8.set([nHist, nFix, hasNet, present, sp, scen, label, 0], base + 672);
});

const outDir = join(here, '..', 'build', 'esp32s3');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `inputs-${split}.bin`);
writeFileSync(out, u8);
process.stderr.write(`${split}: ${lines.length} records, ${u8.length} bytes -> ${out}\n`);
