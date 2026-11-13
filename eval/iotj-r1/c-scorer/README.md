# C trust scorer (R1-9, R3-5)

C99 port of the frozen V1/V2 scorer (`../paper-scorer.mjs`) and the revised
V2' (`../revised-scorer.mjs`), to answer R1-9 ("4.9 µs measured only in Chrome
JavaScript; no embedded or C implementation") and the scorer side of R3-5
(escalation cost). Measured on the desktop and on an ESP32-S3 board
(`esp32s3/`).

- `trust_scorer.h/.c`: `ts_score_v1`, `ts_score_v2`, `ts_score_v2r`, `ts_gate`.
  No heap, no globals, fixed-capacity inputs (history at most 10 points, at most
  5 recent fixes, optional network hint), double precision, same piecewise
  maps, operand order and `Math.round(x * 100) / 100` rounding (ties go up) as
  the JS. Timestamps are int64 epoch milliseconds (`Date.parse` of the ISO
  string, done by the exporter). Input conventions are in the header.
- `ts_driver.c`: `verify` (bit comparison with the JS), `bench`, `ops`
  (built with `-DTS_COUNT_OPS`), `sizes`.
- `export-inputs.mjs`: writes dev/val/test (10,000 traces each) with the JS
  signals and scores of 10 configurations: V1; V2 and V2' with fixes + network,
  fixes only, network only, none; V2' with `accCutoff = 2`.
- `libm-check.mjs` + `libm_check.c`: every libm call the scorers make on those
  traces, recomputed with the platform libm and compared with V8.
- `bench-js.mjs`: the same benchmark on the JS scorers in Node.
- `mcu_entry.c`, `map-summary.mjs`, `stack-summary.mjs`: MCU footprint links,
  map and stack summaries.
- `build.sh` runs everything; `run-android.sh` runs the static aarch64 binary
  on an attached phone (POCO X7 Pro or Jelly Star) and deletes it afterwards;
  `make-report.mjs` writes `../results/c-scorer.json`.

```sh
bash eval/iotj-r1/c-scorer/build.sh          # ~1 min; outputs in c-scorer/build/ (gitignored)
# pieces, after build.sh:
build/host-gcc/ts_driver.exe verify build/inputs-{dev,val,test}.txt
build/host-msvc/ts_driver.exe bench build/inputs-dev.txt 30 32
bash eval/iotj-r1/c-scorer/run-android.sh <adb-serial>   # then: node make-report.mjs
```

Compile the scorer with `-std=c99 -O2 -ffp-contract=off` (GCC, clang) or
`/O2 /fp:precise` (MSVC). Contraction into FMA must stay off: aarch64 and
x86 with FMA would otherwise fuse `a*b + c` (see "Rounding ties").

## Results (2026-11-09, `../results/c-scorer.json`)

Host: AMD Ryzen 9 3950X, Windows 11 Pro. Compilers: MSVC 19.44 (VS 2022 Build
Tools), w64devkit gcc 14.2.0, Android NDK r28 clang 19.0.1, ESP-IDF
crosstool-NG gcc 14.2.0 (xtensa-esp32-elf, riscv32-esp-elf). Node 24.11.1
(V8 13.6).

### Equivalence with the JS

| | x86-64 gcc (mingw-w64 libm) | x86-64 MSVC (UCRT libm) |
|---|---|---|
| trust scores equal, 10 configs x 30,000 traces | 300,000 / 300,000 | 300,000 / 300,000 |
| signal sets bit-identical, per config | 98.9-99.1 % | 99.0-99.1 % |
| signals that ever differ | S1 (268 traces), S4 (31), S4' (48) | S1 (266), S4 (26), S4' (42) |
| largest signal difference | 2 ulp (2.2e-16) | 3 ulp (2.2e-16) |

Every score matches. The signal differences are last-bit libm differences:
against V8, 6.4 % (gcc) / 5.5 % (MSVC) of the distinct `cos` calls and 24.4 % of
the `atan2` calls differ by 1 ulp, `sin` in 0.03 % / 0.02 %, `sqrt` never
(correctly rounded everywhere). They reach S1 through the haversine distance
(speed between 50 and 300 m/s, the interpolated part of the map) and S4/S4'
through `cos(lat)`. For every trace whose signals differ, the raw score is at
least 8.1e-4 (on the x100 scale) away from a rounding tie, eleven orders of
magnitude more than the perturbation, so no score can change. The equivalence
is exact in the score, not in the last bit of every signal; bit-identical
signals would need V8's own libm routines compiled in.

### Rounding ties

Many raw scores land exactly on a tie of `Math.round(raw * 100)`, e.g.
`0.40 + 0.15 * 0.3 + 0.20 + 0.25 = 0.895` (V2, network-only profile, spoofed
accuracy, everything else 1.0). The tie is resolved by binary rounding of the
weighted sum, so a port must repeat the JS operation order exactly.

| config | raw on a tie | changed scores if the sum used ... FMA chain | ties-to-even | float32 |
|---|---|---|---|---|
| V2 fixes only | 5,725 | 5,725 | 0 | 5,725 |
| V2 network only | 9,917 | 4 | 6,758 | 6,584 (2,992 gate decisions at 0.9/0.3) |
| V2' fixes only | 2,841 | 2,840 | 0 | 2,841 (1) |
| V2' network only | 9,910 | 4 | 8,277 | 6,575 (1,466) |
| V2 / V2' full context | 0 / 4 | 0 / 4 | 0 | 0 |

(30,000 traces each; FMA counterfactual from the gcc build, whose `fma()` rounds
once. No gate decision changes at 0.7/0.3.) The 2,992 decisions are the
`accuracy` spoofing traces: in double, 0.895 rounds to 0.90 and passes a 0.9
threshold; in float32 the sum is 0.89499998 and it steps up. Summing in
reverse order changed nothing. A build with `-mfma -ffp-contract=fast`
happened to match all 300,000 scores on this data, but nothing guarantees it.

### Latency (x86-64, dev split, full context)

Per-score latency over the 10,000 dev traces in order (fixes + network),
2 warm-up passes, 30 timed passes, time of 32 consecutive calls / 32; median
and p99 over the 9,360 chunks; median of 3 runs. The C driver pins itself to
one core at high priority.

| | V2 median | V2 p99 | V2' median | V2' p99 |
|---|---|---|---|---|
| C, MSVC 19.44 `/O2 /fp:precise` (UCRT libm) | 275 ns | 475 ns | 344 ns | 591 ns |
| C, gcc 14.2 `-O2 -ffp-contract=off` (mingw-w64 libm) | 1,281 ns | 1,725 ns | 1,525 ns | 1,900 ns |
| JS, Node 24.11 / V8 13.6 | 3,841 ns | 7,913 ns | 7,650 ns | 15,463 ns |

Single calls timed with `lfence; rdtsc` (10 ns TSC granularity on Zen 2,
empty-pair overhead subtracted), MSVC: V2 270 ns median / 720 ns p99, V2'
330 / 900 ns. The gcc build is slower only because of its libm (mingw-w64's
`atan2` is the x87 `fpatan` instruction); the scorer code is the same. The JS
figure also includes parsing ISO timestamps, which the C port receives
pre-parsed. Android aarch64: a static benchmark binary is built
(`build/aarch64/ts_driver`), but no phone was attached during this run.

### Footprint

`sizeof`: `ts_point` 32 B, `ts_history` 328 B, `ts_context` 200 B (input state
560 B), `ts_result` 64 B on x86-64; the ESP32 and ESP32-C3 links place the
same 560 B of inputs. No heap, no static data.

| target, compiler | opt | scorer code + rodata | worst-case stack (V2 / V2') | linked with libm + soft-float helpers |
|---|---|---|---|---|
| ESP32 (Xtensa LX6), gcc 14.2 | -O2 | 9,283 + 200 B | 320 / 448 B | 16.2 KB code + 0.6 KB rodata |
| | -Os | 6,917 + 200 B | 256 / 432 B | 14.1 KB + 0.6 KB |
| ESP32-C3 (RV32IMC), gcc 14.2 | -O2 | 10,770 + 432 B | 720 / 1,152 B | 22.8 KB + 2.0 KB |
| | -Os | 8,386 + 408 B | 608 / 1,040 B | 21.0 KB + 2.0 KB |
| Cortex-M4F, clang 19 (object only) | -O2 | 11,812 + 24 B | 320 / 576 B | n/a (no arm-none-eabi libraries) |
| | -Os | 6,308 + 24 B | 288 / 480 B | |
| aarch64 Android, clang 19 | -O2 | 7,228 + 160 B | 320 / 480 B | |
| | -Os | 3,988 + 416 B | 272 / 464 B | |
| x86-64 Windows, gcc 14.2 | -O2 | 8,496 + 544 B | 784 / 784 B (Win64 frames) | |

Stack is the deepest static call path from the entry point (`-fstack-usage`
plus the call graph), excluding libm and the soft-float helpers; for the GCC
targets tail calls are counted as nested (upper bound). On the ESP32 link,
newlib libm is 6.6 KB (`rem_pio2` alone 3.5 KB) and libgcc's soft-double
helpers 2.5 KB; part of both is in the ESP32 mask ROM in a real ESP-IDF build.

Double precision is required. Cortex-M4F and ESP32/ESP32-S3 have
single-precision FPUs only, ESP32-C3 none: every double operation becomes a
libgcc / `__aeabi_d*` call (`__aeabi_dadd`, `dmul`, `ddiv`, `dcmp*`, `l2d`,
`ui2d` on M4F). Bit equivalence with the JS rules out float32 (see the table
above); a float32 port would need its own validation. Cortex-M7 with FPv5-D16
runs the double arithmetic in hardware.

### Operation counts per score

Instrumented build (`-DTS_COUNT_OPS`), mean [min-max] over dev+val+test.
Arithmetic counted as compiled (x/2, x/0.5 become multiplications).

| | add/sub | mul | div | cmp | int64->double | sqrt | sin | cos | atan2 | floor | haversines |
|---|---|---|---|---|---|---|---|---|---|---|---|
| V1 | 23.2 | 64.1 | 30.2 | 21.6 | 5 | 10 | 10 | 10 | 5 | 1 | 5 |
| V2, fixes + network | 64.4 [64-69] | 92.9 [92-97] | 41.2 [32-43] | 28.3 | 6 | 14 | 12 | 13 | 6 | 1 | 6 |
| V2', fixes + network | 138.4 [29-155] | 121.2 [77-130] | 54.5 [30-58] | 38.6 | 18.1 | 13.8 | 12 | 12.9 | 6 | 1 | 6 |

The C port evaluates each `sin` once where the JS calls it twice. Caching
`cos(lat)` per point (12 haversine `cos` calls on 6 distinct points) would
save 6 `cos` calls without changing any bit; it is not done, to keep the port
a line-by-line mirror.

### ESP32-S3 board (measured, 2026-11-11, `../results/c-scorer-esp32s3.json`)

M5Stack CoreS3 (the body of a Stack-chan), ESP32-S3 at 240 MHz (Xtensa LX7,
single-precision FPU only, so double arithmetic is libgcc soft-float and libm
is newlib), ESP-IDF 5.5.5, gcc 14.2.0 `-O2 -ffp-contract=off`, 32 KB
instruction cache, flash in DIO mode, scorer code run from flash through the
cache. Firmware and scripts are in `esp32s3/`.

- Equivalence: all 30,000 traces x 10 configurations return the JS score
  (300,000 / 300,000), signal masks equal, and every signal is bit-identical
  to V8 (0 differing signal values, unlike the desktop libm builds; newlib's
  and V8's maths routines both derive from fdlibm, which is the likely reason).
- Latency: single calls timed with CCOUNT, interrupts masked around each call,
  empty-pair overhead (1 cycle) subtracted; dev split, 3 passes, median of
  the pass medians. Records are parsed into RAM before a batch is timed.

| | median | p99 | cycles (median) |
|---|---|---|---|
| V1 | 328 µs | 334 µs | 78,650 |
| V2, full context | 438 µs | 444 µs | 105,012 |
| V2', full context | 505 µs | 511 µs | 121,143 |

The three passes agree to the cycle at the median, and val/test give the same
medians within 15 cycles. Verify (12 scores per trace) takes 48 s per split.
The measured V2 cost is about a third of the Cortex-M0 estimate below, which
was meant as a pessimistic bound.

```sh
# build (ESP-IDF 5.5 environment active; with Python 3.14 on PATH set
# IDF_PYTHON_ENV_PATH to the idf5.5_py3.12_env before running activate.py)
idf.py -C eval/iotj-r1/c-scorer/esp32s3 build
for s in dev val test; do node eval/iotj-r1/c-scorer/esp32s3/pack-inputs.mjs $s; done
cd eval/iotj-r1/c-scorer/esp32s3/build
python -m esptool --chip esp32s3 -p COM10 -b 921600 --after watchdog_reset \
  write_flash @flash_args 0x110000 ../../build/esp32s3/inputs-dev.bin
python ../run.py COM10 dev          # sends 'g', saves build/esp32s3/result-dev.json
# val, test: write only the data partition, then run.py
python -m esptool --chip esp32s3 -p COM10 -b 921600 --after watchdog_reset \
  write_flash 0x110000 ../../build/esp32s3/inputs-val.bin
python ../run.py COM10 val
node ../make-report.mjs             # -> results/c-scorer-esp32s3.json
```

Use `--after watchdog_reset`: on this board the default `hard_reset` over
USB-Serial/JTAG left the chip in the ROM download mode, so the firmware never
started. Back up the board's original firmware first (`read_flash`);
`write_flash 0 <backup file>` restores it.

### MCU estimate (superseded by the ESP32-S3 measurement)

Mean counts x per-operation cycle costs of software double precision measured
on a Cortex-M0 (LPC11U68) in the Qfplib-M0-full README: "GCC library"
(dadd 168, dmul 377, ddiv 1,190, dsqrt 1,305, dsin 5,854, dcos 6,162, datan2
9,973 cycles) and Qfplib's own (94 / 163 / 200 / 174 / 1,624 / 1,623 / 2,187).
Comparisons, conversions and `floor` are charged as an addition. A Cortex-M0
has no 32x32->64 multiplier, so this is pessimistic for M4F, Xtensa LX6 and
RV32IMC.

| | GCC soft-double | at 64 / 160 / 240 MHz | Qfplib soft-double | at 64 / 240 MHz |
|---|---|---|---|---|
| V2, full context | 329 kcycles (69 % libm) | 5.1 / 2.1 / 1.4 ms | 89 kcycles | 1.4 / 0.37 ms |
| V2', full context | 371 kcycles (61 % libm) | 5.8 / 2.3 / 1.5 ms | 105 kcycles | 1.6 / 0.44 ms |

## Not measured

- MCU runs: only the ESP32-S3 above. ESP32 (LX6), ESP32-C3 and Cortex-M
  numbers are code size, stack and the estimate above.
- No arm-none-eabi toolchain: Cortex-M4F is object-only (clang with newlib
  headers); its libm / soft-float closure is not linked. ESP32 and ESP32-C3
  are linked with the ESP toolchains' newlib and libgcc.
- Android: no phone was attached when this ran; `run-android.sh` does the
  on-device verify, libm check and benchmark (unpinned and pinned to the
  fastest core) when one is.
