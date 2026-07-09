#!/usr/bin/env bash
# measure.sh — bounded per-arm on-device energy capture via adb (bash variant).
#
#   ./measure.sh begin continuous            # reset + snapshot, then open harness, leave 2-4h
#   ./measure.sh end   continuous            # snapshot + dump batterystats/location -> run.json
#
# Flags: --serial <id>   --session <base>   --dry-run   --results <dir>
# After all three arms:  node ../merge-results.mjs
set -euo pipefail

ACTION="${1:-}"; ARM="${2:-}"; shift $(( $# >= 2 ? 2 : $# )) || true
SERIAL=""; SESSION=""; RESULTS=""; DRYRUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="$2"; shift 2;;
    --session) SESSION="$2"; shift 2;;
    --results) RESULTS="$2"; shift 2;;
    --dry-run) DRYRUN=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

case "$ACTION" in begin|end) ;; *) echo "usage: ./measure.sh begin|end continuous|naive|gated [--dry-run]" >&2; exit 2;; esac
case "$ARM" in continuous|naive|gated) ;; *) echo "arm must be continuous|naive|gated" >&2; exit 2;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE_DIR="$(dirname "$SCRIPT_DIR")"
FIX="$SCRIPT_DIR/fixtures"
[ -n "$RESULTS" ] || RESULTS="$DEVICE_DIR/results"
mkdir -p "$RESULTS"

# per-arm canned counters for --dry-run (POCO X7 Pro, 6000 mAh, ~2h screen-on)
case "$ARM" in
  continuous) L0=92; L1=85; CC0=4800000; CC1=4380000; CUR0=-210000; CUR1=-208000; CAPFULL=6000000;;
  naive)      L0=92; L1=85; CC0=4790000; CC1=4360000; CUR0=-215000; CUR1=-212000; CAPFULL=6000000;;
  gated)      L0=92; L1=86; CC0=4780000; CC1=4410000; CUR0=-186000; CUR1=-95000;  CAPFULL=6000000;;
esac

adb_raw() { if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi; }
now_ms() { node -e 'console.log(Date.now())'; }
get_sysfs() { # $1=node $2=dryval
  if [ "$DRYRUN" -eq 1 ]; then echo "$2"; return; fi
  local v; v="$(adb_raw shell cat "/sys/class/power_supply/battery/$1" 2>/dev/null | tr -d '\r' || true)"
  if printf '%s' "$v" | grep -qE '^-?[0-9]+$'; then echo "$v"; return; fi
  # HyperOS/MIUI deny direct sysfs reads; dumpsys battery exposes the same
  # charge counter (uAh)
  if [ "$1" = "charge_counter" ]; then
    v="$(adb_raw shell dumpsys battery 2>/dev/null | tr -d '\r' | grep -oE 'Charge counter: -?[0-9]+' | grep -oE '\-?[0-9]+' | head -1 || true)"
    if printf '%s' "$v" | grep -qE '^-?[0-9]+$'; then echo "$v"; return; fi
  fi
  echo "null"
}
get_level() { # $1=dryval
  if [ "$DRYRUN" -eq 1 ]; then echo "$1"; return; fi
  adb_raw shell dumpsys battery 2>/dev/null | grep -oE 'level: [0-9]+' | grep -oE '[0-9]+' | head -1 || echo "null"
}

if [ "$ACTION" = "begin" ]; then
  BASE="$ARM.$(date +%Y%m%dT%H%M%S)"
  echo "[measure] BEGIN arm=$ARM session=$BASE dryrun=$DRYRUN"
  if [ "$DRYRUN" -eq 0 ]; then
    echo "[measure] resetting batterystats..."; adb_raw shell dumpsys batterystats --reset >/dev/null
  fi
  CAP=$(get_sysfs charge_full "$CAPFULL"); CAP_MAH="null"; [ "$CAP" != "null" ] && CAP_MAH=$(( CAP / 1000 ))
  cat > "$RESULTS/$BASE.begin.json" <<EOF
{
  "arm": "$ARM",
  "session": "$BASE",
  "schema": "sensing-gate-arm/begin/v1",
  "started_at": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "t0_ms": $(now_ms),
  "level0": $(get_level "$L0"),
  "capacity_mAh": $CAP_MAH,
  "charge_counter0_uAh": $(get_sysfs charge_counter "$CC0"),
  "current_now0_uA": $(get_sysfs current_now "$CUR0"),
  "screen_policy": "screen-on-foreground",
  "dry_run": $([ "$DRYRUN" -eq 1 ] && echo true || echo false)
}
EOF
  echo "[measure] wrote $BASE.begin.json"
  echo ""
  echo "NEXT: open the harness for this arm and leave the phone 2-4h:"
  echo "      harness/index.html?arm=$ARM&autostart=1"
  echo "      then:  ./measure.sh end $ARM $([ "$DRYRUN" -eq 1 ] && echo --dry-run)"
  exit 0
fi

# ---- end ----
if [ -z "$SESSION" ]; then
  for f in $(ls -t "$RESULTS/$ARM."*.begin.json 2>/dev/null || true); do
    b="$(basename "$f" .begin.json)"
    [ -f "$RESULTS/$b.run.json" ] || { SESSION="$b"; break; }
    SESSION="$b"
  done
fi
[ -n "$SESSION" ] || { echo "no begin session for arm=$ARM (run begin first)" >&2; exit 1; }
[ -f "$RESULTS/$SESSION.begin.json" ] || { echo "begin file missing: $SESSION.begin.json" >&2; exit 1; }
echo "[measure] END arm=$ARM session=$SESSION dryrun=$DRYRUN"

BS="$RESULTS/$SESSION.batterystats.txt"; LOC="$RESULTS/$SESSION.location.txt"
if [ "$DRYRUN" -eq 1 ]; then
  cp "$FIX/$ARM.batterystats.txt" "$BS"
  cp "$FIX/location.txt" "$LOC"
  T0=$(node -e "console.log(require('$RESULTS/$SESSION.begin.json').t0_ms)")
  T1=$(( T0 + 7200000 ))
else
  echo "[measure] dumping batterystats --charged ..."
  adb_raw shell dumpsys batterystats --charged > "$BS"
  adb_raw shell dumpsys location > "$LOC"
  T1=$(now_ms)
fi

cat > "$RESULTS/$SESSION.end.json" <<EOF
{
  "arm": "$ARM",
  "session": "$SESSION",
  "schema": "sensing-gate-arm/end/v1",
  "stopped_at": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "t1_ms": $T1,
  "level1": $(get_level "$L1"),
  "charge_counter1_uAh": $(get_sysfs charge_counter "$CC1"),
  "current_now1_uA": $(get_sysfs current_now "$CUR1"),
  "dry_run": $([ "$DRYRUN" -eq 1 ] && echo true || echo false)
}
EOF
echo "[measure] wrote $SESSION.end.json + raw dumps"
echo "[measure] parsing -> $SESSION.run.json"
node "$DEVICE_DIR/parse-run.mjs" --session "$SESSION" --results "$RESULTS"
echo ""
echo "When all three arms are done:  node ../merge-results.mjs"
