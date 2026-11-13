// Summarise a GNU ld map file of the MCU footprint link (build.sh): bytes of
// code (.text/.literal), read-only data (.rodata/.srodata) and RAM
// (.data/.bss/.sdata/.sbss) per origin -- the scorer object, newlib libm,
// libgcc (soft-float helpers), libc -- plus the libm / libgcc members pulled in.
//
// Usage: node map-summary.mjs <link.map>   (prints JSON)

import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
const start = text.indexOf('Linker script and memory map');
const lines = text.slice(start).split(/\r?\n/);

const kindOf = (sec) =>
  /^\.(text|literal)/.test(sec) ? 'code'
  : /^\.s?rodata/.test(sec) ? 'rodata'
  : /^\.(s?data|s?bss)/.test(sec) ? 'ram'
  : null;
const originOf = (file) =>
  /(trust_scorer|fp-O[2s])\.o$/.test(file) ? 'scorer'
  : /(mcu_entry|entry-O[2s])\.o$/.test(file) ? 'entry'
  : /libm\.a\(/.test(file) ? 'libm'
  : /libgcc\.a\(/.test(file) ? 'libgcc'
  : /lib(c|nosys)\.a\(/.test(file) ? 'libc'
  : 'other';

const totals = {};
const members = { libm: {}, libgcc: {}, libc: {} };
let pending = null;
for (const line of lines) {
  let m = line.match(/^ (\.\S+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/);
  if (!m && pending) {
    const m2 = line.match(/^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/);
    if (m2) m = [null, pending, m2[1], m2[2], m2[3]];
  }
  pending = null;
  if (!m) {
    const n = line.match(/^ (\.\S+)\s*$/);
    if (n) pending = n[1];
    continue;
  }
  const [, sec, , sizeHex, file] = m;
  const size = parseInt(sizeHex, 16);
  const kind = kindOf(sec);
  if (!kind || size === 0) continue;
  const origin = originOf(file.trim());
  totals[origin] ??= { code: 0, rodata: 0, ram: 0 };
  totals[origin][kind] += size;
  if (members[origin]) {
    const mem = file.match(/\(([^)]+)\)/)?.[1] ?? file;
    members[origin][mem] = (members[origin][mem] ?? 0) + (kind === 'ram' ? 0 : size);
  }
}
const sum = (k) => Object.values(totals).reduce((s, t) => s + t[k], 0);
console.log(JSON.stringify({ byOrigin: totals, total: { code: sum('code'), rodata: sum('rodata'), ram: sum('ram') }, members }));
