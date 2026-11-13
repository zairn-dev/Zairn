#!/usr/bin/env bash
# Run the static aarch64 binaries (build.sh) on an attached Android phone and
# delete them afterwards. Touches nothing else on the device: it only creates
# and removes /data/local/tmp/ts-c-scorer and reads a few build properties
# and CPU frequency limits for the report.
#
#   bash eval/iotj-r1/c-scorer/run-android.sh <adb-serial>
set -euo pipefail

SERIAL=$1
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/build"
A="$B/aarch64"
LOCAL=${LOCALAPPDATA:-/c/Users/$USERNAME/AppData/Local}
LOCAL=$(cygpath -u "$LOCAL" 2>/dev/null || echo "$LOCAL")
ADB=${ADB:-$LOCAL/Android/Sdk/platform-tools/adb.exe}
export MSYS_NO_PATHCONV=1
DIR=/data/local/tmp/ts-c-scorer

adb_() { "$ADB" -s "$SERIAL" "$@"; }
win() { cygpath -w "$1"; }
cleanup() { adb_ shell rm -rf "$DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

adb_ shell mkdir -p "$DIR"
for f in "$A/ts_driver" "$A/libm_check" "$B/inputs-dev.txt" "$B/inputs-val.txt" "$B/inputs-test.txt" "$B/libm-calls.txt"; do
  adb_ push "$(win "$f")" "$DIR/" >/dev/null
done
adb_ shell chmod 755 "$DIR/ts_driver" "$DIR/libm_check"

prop() { adb_ shell getprop "$1" | tr -d '\r'; }
# fastest core (highest cpuinfo_max_freq) for a pinned run
CORES=$(adb_ shell 'for c in /sys/devices/system/cpu/cpu[0-9]*; do echo "${c##*cpu} $(cat $c/cpufreq/cpuinfo_max_freq 2>/dev/null || echo 0)"; done' | tr -d '\r')
BIG=$(echo "$CORES" | sort -k2,2n | tail -1 | cut -d' ' -f1)
MASK=$(printf '%x' $((1 << BIG)))
cat > "$B/android-device.json" <<EOF
{"serial":"$SERIAL","model":"$(prop ro.product.model)","manufacturer":"$(prop ro.product.manufacturer)",
 "soc":"$(prop ro.soc.manufacturer) $(prop ro.soc.model)","hardware":"$(prop ro.hardware)",
 "android":"$(prop ro.build.version.release)","abi":"$(prop ro.product.cpu.abi)",
 "coreMaxKHz":"$(echo "$CORES" | tr '\n' ';')","pinnedCore":$BIG}
EOF

adb_ shell "cd $DIR && ./ts_driver sizes" > "$B/sizes-android.json"
adb_ shell "cd $DIR && ./ts_driver verify inputs-dev.txt inputs-val.txt inputs-test.txt" > "$B/verify-android.json"
adb_ shell "cd $DIR && ./libm_check libm-calls.txt" > "$B/libm-android.json"
for r in 1 2 3; do
  adb_ shell "cd $DIR && ./ts_driver bench inputs-dev.txt 30 32" > "$B/bench-android-$r.json"
  adb_ shell "cd $DIR && taskset $MASK ./ts_driver bench inputs-dev.txt 30 32" > "$B/bench-android-bigcore-$r.json"
done
echo "android run on $SERIAL done; $DIR removed on exit" >&2
