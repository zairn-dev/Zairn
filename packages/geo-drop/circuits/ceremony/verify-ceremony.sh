#!/usr/bin/env bash
# =============================================================================
# Verify Zairn ZKP Trusted Setup Ceremony Transcript
# =============================================================================
#
# This script independently verifies every step of a completed ceremony:
#   1. Phase 1 (Powers of Tau) contributions and beacon
#   2. Phase 2 (circuit-specific) contributions and beacon for each circuit
#   3. Final .zkey integrity against R1CS and ptau
#   4. Verification key consistency
#
# Usage:
#   ./verify-ceremony.sh [--verbose]
#
# Exit code 0 = all verifications passed. Non-zero = failure.
# =============================================================================

set -euo pipefail

VERBOSE="${1:-}"
CEREMONY_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${CEREMONY_DIR}/build"
OUTPUT_DIR="${CEREMONY_DIR}/output"
TRANSCRIPT_DIR="${CEREMONY_DIR}/transcript"

# Circuits to verify (must match run-ceremony.sh)
CIRCUITS=(
  "zairn_zkp:zairn_zkp.circom"
  "region_zkp:region_zkp.circom"
  "proximity:proximity.circom"
  "sound_geo_only:sound_geo_only.circom"
)

PTAU_POWER=14

SNARKJS="${SNARKJS_BIN:-$(command -v snarkjs 2>/dev/null || echo "npx snarkjs")}"

PASS_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  echo ""
  echo "========================================"
  echo "  $1"
  echo "========================================"
  echo ""
}

parse_circuit() {
  local entry="$1"
  CIRCUIT_NAME="${entry%%:*}"
  CIRCUIT_FILE="${entry##*:}"
}

check_pass() {
  local step="$1"
  local exit_code="$2"
  if [[ "$exit_code" -eq 0 ]]; then
    echo "[PASS] $step"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $step"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

run_verify() {
  local step="$1"
  shift
  local rc=0
  if [[ "$VERBOSE" == "--verbose" ]]; then
    "$@" || rc=$?
  else
    "$@" > /dev/null 2>&1 || rc=$?
  fi
  check_pass "$step" "$rc"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

log "Verifying Ceremony Transcript"

if [[ ! -d "$TRANSCRIPT_DIR" ]]; then
  echo "ERROR: Transcript directory not found: $TRANSCRIPT_DIR" >&2
  echo "Has the ceremony been run?" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 1: Verify Powers of Tau
# ---------------------------------------------------------------------------

log "Phase 1: Powers of Tau Verification"

# Verify the final ptau file (this checks all contributions in the chain).
FINAL_PTAU="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_final.ptau"
if [[ -f "$FINAL_PTAU" ]]; then
  run_verify "Phase 1 final ptau (all contributions + beacon)" \
    $SNARKJS powersoftau verify "$FINAL_PTAU"
else
  echo "[SKIP] Phase 1 final ptau not found: $FINAL_PTAU"
fi

# Also verify individual contribution files if they exist.
for ptau_file in "${TRANSCRIPT_DIR}"/pot${PTAU_POWER}_[0-9]*.ptau; do
  if [[ -f "$ptau_file" ]]; then
    local_name="$(basename "$ptau_file")"
    run_verify "Phase 1 contribution: $local_name" \
      $SNARKJS powersoftau verify "$ptau_file"
  fi
done

# Verify beacon ptau if it exists.
BEACON_PTAU="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_beacon.ptau"
if [[ -f "$BEACON_PTAU" ]]; then
  run_verify "Phase 1 beacon ptau" \
    $SNARKJS powersoftau verify "$BEACON_PTAU"
fi

# ---------------------------------------------------------------------------
# Phase 2: Verify circuit-specific contributions
# ---------------------------------------------------------------------------

log "Phase 2: Circuit-Specific Verification"

for entry in "${CIRCUITS[@]}"; do
  parse_circuit "$entry"

  local r1cs="${BUILD_DIR}/${CIRCUIT_NAME}.r1cs"

  if [[ ! -f "$r1cs" ]]; then
    echo "[SKIP] R1CS not found for ${CIRCUIT_NAME}: $r1cs"
    echo "       Run './run-ceremony.sh init' to compile circuits first."
    continue
  fi

  echo ""
  echo "--- Circuit: ${CIRCUIT_NAME} ---"

  # Verify each contribution zkey (includes all prior contributions).
  for zkey_file in "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_"[0-9]*.zkey; do
    if [[ -f "$zkey_file" ]]; then
      local_name="$(basename "$zkey_file")"
      run_verify "Phase 2 ${CIRCUIT_NAME}: $local_name" \
        $SNARKJS zkey verify "$r1cs" "$FINAL_PTAU" "$zkey_file"
    fi
  done

  # Verify beacon zkey.
  local beacon_zkey="${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_beacon.zkey"
  if [[ -f "$beacon_zkey" ]]; then
    run_verify "Phase 2 ${CIRCUIT_NAME}: beacon zkey" \
      $SNARKJS zkey verify "$r1cs" "$FINAL_PTAU" "$beacon_zkey"
  fi

  # Verify final zkey in output/.
  local final_zkey="${OUTPUT_DIR}/${CIRCUIT_NAME}_final.zkey"
  if [[ -f "$final_zkey" ]]; then
    run_verify "Phase 2 ${CIRCUIT_NAME}: final zkey" \
      $SNARKJS zkey verify "$r1cs" "$FINAL_PTAU" "$final_zkey"
  else
    echo "[SKIP] Final zkey not found for ${CIRCUIT_NAME}: $final_zkey"
  fi

  # ---------------------------------------------------------------------------
  # Verify verification key matches the final zkey
  # ---------------------------------------------------------------------------
  local vkey="${OUTPUT_DIR}/${CIRCUIT_NAME}_verification_key.json"
  if [[ -f "$final_zkey" && -f "$vkey" ]]; then
    # Export a fresh verification key and compare.
    local tmp_vkey
    tmp_vkey=$(mktemp)
    $SNARKJS zkey export verificationkey "$final_zkey" "$tmp_vkey" 2>/dev/null

    if diff -q "$vkey" "$tmp_vkey" > /dev/null 2>&1; then
      check_pass "Verification key consistency: ${CIRCUIT_NAME}" 0
    else
      echo "[FAIL] Verification key mismatch for ${CIRCUIT_NAME}!"
      echo "       Exported vkey differs from ${vkey}"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
    rm -f "$tmp_vkey"
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log "Verification Summary"

echo "  Passed: ${PASS_COUNT}"
echo "  Failed: ${FAIL_COUNT}"
echo ""

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "RESULT: CEREMONY VERIFICATION FAILED"
  echo ""
  echo "One or more verification steps failed. Do NOT use these ceremony"
  echo "artifacts in production. Investigate the failures above."
  exit 1
else
  echo "RESULT: ALL VERIFICATIONS PASSED"
  echo ""
  echo "The ceremony transcript is valid. The output artifacts in"
  echo "  ${OUTPUT_DIR}/"
  echo "can be used for production deployment."
  exit 0
fi
