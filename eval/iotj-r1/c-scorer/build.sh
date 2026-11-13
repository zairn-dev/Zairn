#!/usr/bin/env bash
# Build, verify, benchmark and measure the C trust scorer (Git Bash on Windows).
#
#   bash eval/iotj-r1/c-scorer/build.sh
#
# Steps: export JS inputs/scores -> host gcc (verify, bench, op counts) ->
# host MSVC (verify, bench) -> Node baseline bench -> Android aarch64 static
# binaries -> MCU objects / footprint links (ESP32, ESP32-C3, Cortex-M4F) ->
# optional run on an attached Android phone -> results/c-scorer.json.
# Toolchains are found at their default install paths; override with the
# variables below. Missing toolchains are skipped.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/build"
LOCAL=${LOCALAPPDATA:-/c/Users/$USERNAME/AppData/Local}
LOCAL=$(cygpath -u "$LOCAL" 2>/dev/null || echo "$LOCAL")
CC_HOST=${CC_HOST:-gcc}
NDK_BIN=${NDK_BIN:-$(ls -d "$LOCAL"/Android/Sdk/ndk/*/toolchains/llvm/prebuilt/windows-x86_64/bin 2>/dev/null | sort -V | tail -1)}
ESP_TOOLS=${ESP_TOOLS:-$HOME/.espressif/tools}
XTENSA_BIN=${XTENSA_BIN:-$(ls -d "$ESP_TOOLS"/xtensa-esp-elf/*/xtensa-esp-elf/bin 2>/dev/null | tail -1)}
RISCV_BIN=${RISCV_BIN:-$(ls -d "$ESP_TOOLS"/riscv32-esp-elf/*/riscv32-esp-elf/bin 2>/dev/null | tail -1)}
# newest MSVC toolset among the installed Visual Studio 2022 editions
VCVARS=${VCVARS:-$(ls -d "/c/Program Files"*/Microsoft\ Visual\ Studio/2022/*/VC/Tools/MSVC/* 2>/dev/null |
  sed 's#/$##' | awk -F/ '{print $NF "\t" $0}' | sort -V | tail -1 | cut -f2 |
  sed 's#/VC/Tools/MSVC/.*#/VC/Auxiliary/Build/vcvars64.bat#')}
ADB=${ADB:-$LOCAL/Android/Sdk/platform-tools/adb.exe}
PHONES=${PHONES:-"LZFIQCJ7KNEERKMN JELLYS0000010125"}
RUNS=${RUNS:-3} # benchmark repetitions per platform

# Strict IEEE double, no FMA contraction (see README "Equivalence").
STRICT="-std=c99 -O2 -ffp-contract=off"
INPUTS="$B/inputs-dev.txt $B/inputs-val.txt $B/inputs-test.txt"
mkdir -p "$B"
cd "$HERE"
log() { printf '\n== %s\n' "$*" >&2; }

# ---------------------------------------------------------------- inputs
log "export JS inputs and scores"
node export-inputs.mjs "$B"
node libm-check.mjs "$B/libm-calls.txt"

# ---------------------------------------------------------------- host gcc
log "host gcc: $($CC_HOST --version | head -1)"
mkdir -p "$B/host-gcc"
H="$B/host-gcc"
$CC_HOST $STRICT -Wall -Wextra -pedantic -c trust_scorer.c -o "$H/trust_scorer.o"
$CC_HOST $STRICT -ffunction-sections -fstack-usage -fcallgraph-info=su -c trust_scorer.c -o "$H/trust_scorer_fp.o"
$CC_HOST -std=gnu99 -O2 -ffp-contract=off -D__USE_MINGW_ANSI_STDIO=1 ts_driver.c "$H/trust_scorer.o" -o "$H/ts_driver.exe" -lm
$CC_HOST $STRICT -DTS_COUNT_OPS -c trust_scorer.c -o "$H/trust_scorer_ops.o"
$CC_HOST -std=gnu99 -O2 -ffp-contract=off -DTS_COUNT_OPS -D__USE_MINGW_ANSI_STDIO=1 ts_driver.c "$H/trust_scorer_ops.o" -o "$H/ts_driver_ops.exe" -lm
$CC_HOST $STRICT -D__USE_MINGW_ANSI_STDIO=1 libm_check.c -o "$H/libm_check.exe" -lm
# contraction-enabled variant, to show what -ffp-contract=off protects against
$CC_HOST -std=gnu99 -O2 -mfma -ffp-contract=fast -c trust_scorer.c -o "$H/trust_scorer_fma.o"
$CC_HOST -std=gnu99 -O2 -ffp-contract=off -D__USE_MINGW_ANSI_STDIO=1 ts_driver.c "$H/trust_scorer_fma.o" -o "$H/ts_driver_fma.exe" -lm
"$H/ts_driver.exe" verify $INPUTS > "$B/verify-host-gcc.json"
"$H/ts_driver_fma.exe" verify $INPUTS > "$B/verify-host-gcc-fma.json" 2>/dev/null || true
"$H/libm_check.exe" "$B/libm-calls.txt" > "$B/libm-host-gcc.json"
"$H/ts_driver_ops.exe" ops $INPUTS > "$B/ops.json"
"$H/ts_driver.exe" sizes > "$B/sizes-host.json"
for r in $(seq 1 "$RUNS"); do "$H/ts_driver.exe" bench "$B/inputs-dev.txt" 30 32 > "$B/bench-host-gcc-$r.json"; done
objdump -h "$H/trust_scorer_fp.o" > "$H/sections.txt"
mv -f "$H"/trust_scorer_fp.su "$H/trust_scorer.su" 2>/dev/null || true
mv -f "$H"/trust_scorer_fp.ci "$H/trust_scorer.ci" 2>/dev/null || true

# ---------------------------------------------------------------- host MSVC
if [ -n "$VCVARS" ]; then
  log "host MSVC ($VCVARS)"
  mkdir -p "$B/host-msvc"
  cat > "$B/host-msvc/build.bat" <<EOF
@echo off
call "$(cygpath -w "$VCVARS")" >nul || exit /b 1
cd /d "$(cygpath -w "$HERE")"
set F=/nologo /O2 /fp:precise /std:c11 /W3 /D_CRT_SECURE_NO_WARNINGS
cl %F% /c trust_scorer.c /Fobuild\\host-msvc\\trust_scorer.obj || exit /b 1
cl %F% ts_driver.c build\\host-msvc\\trust_scorer.obj /Fobuild\\host-msvc\\ts_driver.obj /Febuild\\host-msvc\\ts_driver.exe || exit /b 1
cl %F% libm_check.c /Fobuild\\host-msvc\\libm_check.obj /Febuild\\host-msvc\\libm_check.exe || exit /b 1
cl 2>&1 | findstr /C:"Version" > build\\host-msvc\\version.txt
EOF
  MSYS_NO_PATHCONV=1 cmd.exe /c "$(cygpath -w "$B/host-msvc/build.bat")" >&2
  "$B/host-msvc/ts_driver.exe" verify $INPUTS > "$B/verify-host-msvc.json"
  "$B/host-msvc/libm_check.exe" "$B/libm-calls.txt" > "$B/libm-host-msvc.json"
  for r in $(seq 1 "$RUNS"); do "$B/host-msvc/ts_driver.exe" bench "$B/inputs-dev.txt" 30 32 > "$B/bench-host-msvc-$r.json"; done
fi

# ---------------------------------------------------------------- Node baseline
log "Node baseline"
for r in $(seq 1 "$RUNS"); do node bench-js.mjs 30 32 > "$B/bench-js-$r.json"; done

# ---------------------------------------------------------------- host info
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | ConvertTo-Json -Compress" > "$B/host-cpu.json"

# ---------------------------------------------------------------- Android aarch64
if [ -n "$NDK_BIN" ]; then
  log "Android aarch64: $("$NDK_BIN/clang.exe" --version | head -1)"
  A="$B/aarch64"
  mkdir -p "$A"
  ACC=("$NDK_BIN/clang.exe" --target=aarch64-linux-android30)
  "${ACC[@]}" $STRICT -Wall -Wextra -c trust_scorer.c -o "$A/trust_scorer.o"
  "${ACC[@]}" -std=gnu99 -O2 -ffp-contract=off -static ts_driver.c "$A/trust_scorer.o" -o "$A/ts_driver" -lm
  "${ACC[@]}" $STRICT -static libm_check.c -o "$A/libm_check" -lm
  for OPT in O2 Os; do
    "${ACC[@]}" -std=c99 -$OPT -ffp-contract=off -ffunction-sections -fdata-sections -fstack-usage \
      -c trust_scorer.c -o "$A/fp-$OPT.o"
    "$NDK_BIN/llvm-size.exe" -A "$A/fp-$OPT.o" > "$A/fp-$OPT.size.txt"
    "$NDK_BIN/llvm-objdump.exe" -dr "$A/fp-$OPT.o" > "$A/fp-$OPT.dis"
  done
  echo "$("$NDK_BIN/clang.exe" --version | head -1)" > "$A/version.txt"
fi

# ---------------------------------------------------------------- MCU footprint
mcu_gcc() { # name gcc-binary size-binary flags...
  local name=$1 gcc=$2 size=$3; shift 3
  local D="$B/$name"
  mkdir -p "$D"
  "$gcc" --version | head -1 > "$D/version.txt"
  for OPT in O2 Os; do
    "$gcc" -std=c99 -$OPT -ffp-contract=off -ffunction-sections -fdata-sections "$@" \
      -fstack-usage -fcallgraph-info=su -c trust_scorer.c -o "$D/fp-$OPT.o"
    "$size" -A "$D/fp-$OPT.o" > "$D/fp-$OPT.size.txt"
    "$gcc" -std=c99 -$OPT "$@" -ffunction-sections -fdata-sections -c mcu_entry.c -o "$D/entry-$OPT.o"
    "$gcc" "$@" -nostartfiles -Wl,--gc-sections -Wl,-e,app_entry -Wl,-Map,"$D/link-$OPT.map" \
      "$D/entry-$OPT.o" "$D/fp-$OPT.o" -o "$D/link-$OPT.elf" -lm -lc -lgcc 2>/dev/null
    "$size" -A "$D/link-$OPT.elf" > "$D/link-$OPT.size.txt"
  done
}
if [ -n "$XTENSA_BIN" ]; then
  log "ESP32 (Xtensa LX6)"
  mcu_gcc esp32 "$XTENSA_BIN/xtensa-esp32-elf-gcc.exe" "$XTENSA_BIN/xtensa-esp32-elf-size.exe" -mlongcalls
fi
if [ -n "$RISCV_BIN" ]; then
  log "ESP32-C3 (RV32IMC)"
  mcu_gcc esp32c3 "$RISCV_BIN/riscv32-esp-elf-gcc.exe" "$RISCV_BIN/riscv32-esp-elf-size.exe" \
    -march=rv32imc_zicsr_zifencei -mabi=ilp32
fi
if [ -n "$NDK_BIN" ] && [ -n "$RISCV_BIN" ]; then
  # No arm-none-eabi toolchain here: compile-only with the NDK's clang and
  # newlib's (architecture-neutral) headers from the ESP toolchain.
  log "Cortex-M4F (clang, object only)"
  D="$B/cortex-m4f"
  mkdir -p "$D"
  NEWLIB_INC=$(ls -d "$RISCV_BIN"/../riscv32-esp-elf/include | head -1)
  for OPT in O2 Os; do
    "$NDK_BIN/clang.exe" --target=thumbv7em-none-eabihf -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard \
      -mthumb -std=c99 -$OPT -ffp-contract=off -ffunction-sections -fdata-sections -fstack-usage \
      -isystem "$NEWLIB_INC" -c trust_scorer.c -o "$D/fp-$OPT.o"
    "$NDK_BIN/llvm-size.exe" -A "$D/fp-$OPT.o" > "$D/fp-$OPT.size.txt"
    "$NDK_BIN/llvm-objdump.exe" -dr "$D/fp-$OPT.o" > "$D/fp-$OPT.dis"
    "$NDK_BIN/llvm-nm.exe" -u "$D/fp-$OPT.o" > "$D/fp-$OPT.undef.txt"
  done
  "$NDK_BIN/clang.exe" --version | head -1 > "$D/version.txt"
fi

# ---------------------------------------------------------------- Android run
SERIAL=""
if [ -x "$ADB" ] || [ -f "$ADB" ]; then
  for s in $PHONES; do
    if MSYS_NO_PATHCONV=1 "$ADB" devices | grep -q "^$s[[:space:]]*device"; then SERIAL=$s; break; fi
  done
fi
if [ -n "$SERIAL" ] && [ -f "$B/aarch64/ts_driver" ]; then
  log "Android run on $SERIAL"
  bash "$HERE/run-android.sh" "$SERIAL"
else
  log "no supported Android device attached; skipping the on-device run"
fi

# ---------------------------------------------------------------- report
log "report"
node make-report.mjs
