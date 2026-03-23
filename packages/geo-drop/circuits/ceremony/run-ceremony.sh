#!/usr/bin/env bash
# =============================================================================
# Multi-Party Trusted Setup Ceremony for Zairn ZKP Circuits
# =============================================================================
#
# Usage:
#   ./run-ceremony.sh init                              # Initialize ceremony
#   ./run-ceremony.sh phase1-contribute <N> "<name>"    # Phase 1 contribution
#   ./run-ceremony.sh phase1-finalize                   # Finalize Phase 1
#   ./run-ceremony.sh phase2-contribute <N> "<name>"    # Phase 2 contribution
#   ./run-ceremony.sh phase2-finalize                   # Finalize Phase 2
#
# Requirements: circom >= 2.1.0, snarkjs >= 0.7.0, node >= 18
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directory containing the .circom source files (one level up from ceremony/)
CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CEREMONY_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${CEREMONY_DIR}/build"
OUTPUT_DIR="${CEREMONY_DIR}/output"
TRANSCRIPT_DIR="${CEREMONY_DIR}/transcript"

# All circuits to include in the ceremony.
# Format: "name:source_file"
CIRCUITS=(
  "zairn_zkp:zairn_zkp.circom"
  "region_zkp:region_zkp.circom"
  "proximity:proximity.circom"
  "sound_geo_only:sound_geo_only.circom"
)

# Powers of Tau exponent. 2^14 = 16384 constraints.
# Increase if any circuit exceeds this. region_zkp with 16 vertices
# may need up to ~12000 constraints, so 2^14 provides headroom.
PTAU_POWER=14

# snarkjs command — use npx fallback if not globally installed.
SNARKJS="${SNARKJS_BIN:-$(command -v snarkjs 2>/dev/null || echo "npx snarkjs")}"

# circom command
CIRCOM="${CIRCOM_BIN:-$(command -v circom 2>/dev/null || echo "circom")}"

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

check_prerequisites() {
  if ! command -v node &>/dev/null; then
    echo "ERROR: node is required but not found in PATH." >&2
    exit 1
  fi
  # Test snarkjs availability
  if ! $SNARKJS --version &>/dev/null 2>&1; then
    echo "ERROR: snarkjs is required. Install with: npm install -g snarkjs" >&2
    exit 1
  fi
}

# Parse circuit entry "name:file" into NAME and FILE variables.
parse_circuit() {
  local entry="$1"
  CIRCUIT_NAME="${entry%%:*}"
  CIRCUIT_FILE="${entry##*:}"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_init() {
  log "Initializing Ceremony"

  check_prerequisites
  mkdir -p "$BUILD_DIR" "$OUTPUT_DIR" "$TRANSCRIPT_DIR"

  # ------------------------------------------------------------------
  # Step 1: Compile all circuits
  # ------------------------------------------------------------------
  for entry in "${CIRCUITS[@]}"; do
    parse_circuit "$entry"
    local src="${CIRCUITS_DIR}/${CIRCUIT_FILE}"

    if [[ ! -f "$src" ]]; then
      echo "ERROR: Circuit source not found: $src" >&2
      exit 1
    fi

    log "Compiling ${CIRCUIT_NAME} (${CIRCUIT_FILE})"
    $CIRCOM "$src" \
      --r1cs --wasm --sym \
      -o "$BUILD_DIR/" \
      -l "${CIRCUITS_DIR}" \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_compile.log"

    echo "  R1CS:  ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs"
    echo "  WASM:  ${BUILD_DIR}/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
  done

  # ------------------------------------------------------------------
  # Step 2: Generate initial Powers of Tau (Phase 1 start)
  # ------------------------------------------------------------------
  log "Generating initial Powers of Tau (2^${PTAU_POWER})"

  local ptau_init="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_0000.ptau"
  $SNARKJS powersoftau new bn128 "$PTAU_POWER" "$ptau_init" -v \
    2>&1 | tee "${TRANSCRIPT_DIR}/phase1_init.log"

  echo ""
  echo "Initialization complete."
  echo "Next step: Each contributor runs:"
  echo "  ./run-ceremony.sh phase1-contribute <N> \"<name>\""
  echo ""
  echo "Contributor 1 starts with N=1."
}

cmd_phase1_contribute() {
  local contrib_num="${1:?Usage: phase1-contribute <N> \"<name>\"}"
  local contrib_name="${2:?Usage: phase1-contribute <N> \"<name>\"}"

  check_prerequisites

  local prev_num=$((contrib_num - 1))
  local prev_ptau="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_$(printf '%04d' $prev_num).ptau"
  local next_ptau="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_$(printf '%04d' $contrib_num).ptau"

  if [[ ! -f "$prev_ptau" ]]; then
    echo "ERROR: Previous contribution not found: $prev_ptau" >&2
    echo "Make sure contribution $prev_num has been completed." >&2
    exit 1
  fi

  log "Phase 1 Contribution #${contrib_num} by ${contrib_name}"

  echo "You will be prompted for random text. Type random characters as entropy."
  echo ""

  $SNARKJS powersoftau contribute \
    "$prev_ptau" "$next_ptau" \
    --name="${contrib_name}" \
    -v \
    2>&1 | tee "${TRANSCRIPT_DIR}/phase1_contribute_${contrib_num}.log"

  echo ""
  echo "Phase 1 contribution #${contrib_num} complete."
  echo "Output: $next_ptau"
  echo ""
  echo "IMPORTANT: The contribution hash above should be recorded publicly"
  echo "by the contributor as an attestation."
  echo ""

  if [[ $contrib_num -lt 5 ]]; then
    echo "Next: Pass $next_ptau to the next contributor, who runs:"
    echo "  ./run-ceremony.sh phase1-contribute $((contrib_num + 1)) \"<name>\""
  else
    echo "All 5 Phase 1 contributions done. Next:"
    echo "  ./run-ceremony.sh phase1-finalize"
  fi
}

cmd_phase1_verify() {
  # Verify Phase 1 contributions up to the latest .ptau file.
  check_prerequisites

  log "Verifying Phase 1 Contributions"

  # Find the latest contribution file.
  local latest_ptau
  latest_ptau=$(ls -1 "${TRANSCRIPT_DIR}"/pot${PTAU_POWER}_*.ptau 2>/dev/null \
    | grep -v 'final' | sort | tail -1)

  if [[ -z "$latest_ptau" ]]; then
    echo "ERROR: No Phase 1 .ptau files found in ${TRANSCRIPT_DIR}/" >&2
    exit 1
  fi

  echo "Verifying: $latest_ptau"
  $SNARKJS powersoftau verify "$latest_ptau" \
    2>&1 | tee "${TRANSCRIPT_DIR}/phase1_verify.log"
}

cmd_phase1_finalize() {
  check_prerequisites

  log "Finalizing Phase 1 (Powers of Tau)"

  # Find the latest contribution file.
  local latest_ptau
  latest_ptau=$(ls -1 "${TRANSCRIPT_DIR}"/pot${PTAU_POWER}_*.ptau 2>/dev/null \
    | grep -v 'final' | sort | tail -1)

  if [[ -z "$latest_ptau" ]]; then
    echo "ERROR: No Phase 1 .ptau files found in ${TRANSCRIPT_DIR}/" >&2
    exit 1
  fi

  echo "Latest contribution: $latest_ptau"

  # ------------------------------------------------------------------
  # Apply random beacon
  # ------------------------------------------------------------------
  # The beacon should be a publicly verifiable random value that was not
  # known at the time contributions were made. A common choice is a
  # Bitcoin block hash at a predetermined future block height.
  #
  # For this script, we use a placeholder beacon. In a real ceremony,
  # replace this with the actual beacon value.
  # ------------------------------------------------------------------

  local beacon_ptau="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_beacon.ptau"
  local final_ptau="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_final.ptau"

  echo ""
  echo "Applying random beacon..."
  echo "In production, use a publicly verifiable value (e.g., Bitcoin block hash)."
  echo "Default beacon: 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  echo ""

  # 10 iterations of SHA-256 on the beacon value for additional mixing.
  $SNARKJS powersoftau beacon \
    "$latest_ptau" "$beacon_ptau" \
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" 10 \
    -n="Final Beacon" \
    2>&1 | tee "${TRANSCRIPT_DIR}/phase1_beacon.log"

  # ------------------------------------------------------------------
  # Prepare Phase 2
  # ------------------------------------------------------------------
  log "Preparing Phase 2"

  $SNARKJS powersoftau prepare phase2 \
    "$beacon_ptau" "$final_ptau" \
    -v \
    2>&1 | tee "${TRANSCRIPT_DIR}/phase1_prepare_phase2.log"

  echo ""
  echo "Phase 1 finalized."
  echo "Final ptau: $final_ptau"
  echo ""

  # ------------------------------------------------------------------
  # Generate initial .zkey for each circuit (Phase 2 start)
  # ------------------------------------------------------------------
  for entry in "${CIRCUITS[@]}"; do
    parse_circuit "$entry"
    local r1cs="${BUILD_DIR}/${CIRCUIT_NAME}.r1cs"
    local zkey_init="${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_0000.zkey"

    if [[ ! -f "$r1cs" ]]; then
      echo "WARNING: R1CS not found for ${CIRCUIT_NAME}, skipping: $r1cs" >&2
      continue
    fi

    log "Generating initial .zkey for ${CIRCUIT_NAME}"
    $SNARKJS groth16 setup \
      "$r1cs" "$final_ptau" "$zkey_init" \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_setup.log"

    echo "  Initial zkey: $zkey_init"
  done

  echo ""
  echo "Phase 2 initialized. Next: Each contributor runs:"
  echo "  ./run-ceremony.sh phase2-contribute <N> \"<name>\""
}

cmd_phase2_contribute() {
  local contrib_num="${1:?Usage: phase2-contribute <N> \"<name>\"}"
  local contrib_name="${2:?Usage: phase2-contribute <N> \"<name>\"}"

  check_prerequisites

  local prev_num=$((contrib_num - 1))

  log "Phase 2 Contribution #${contrib_num} by ${contrib_name}"

  echo "Contributing to all circuits..."
  echo "You will be prompted for random text for EACH circuit."
  echo ""

  for entry in "${CIRCUITS[@]}"; do
    parse_circuit "$entry"

    local prev_zkey="${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_$(printf '%04d' $prev_num).zkey"
    local next_zkey="${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_$(printf '%04d' $contrib_num).zkey"

    if [[ ! -f "$prev_zkey" ]]; then
      echo "WARNING: Previous zkey not found for ${CIRCUIT_NAME}: $prev_zkey" >&2
      echo "Skipping this circuit." >&2
      continue
    fi

    log "Contributing to ${CIRCUIT_NAME} (Phase 2, #${contrib_num})"

    $SNARKJS zkey contribute \
      "$prev_zkey" "$next_zkey" \
      --name="${contrib_name}" \
      -v \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_contribute_${contrib_num}.log"

    echo "  Output: $next_zkey"
  done

  echo ""
  echo "Phase 2 contribution #${contrib_num} complete for all circuits."
  echo ""
  echo "IMPORTANT: Record the contribution hashes printed above publicly."
  echo ""

  if [[ $contrib_num -lt 5 ]]; then
    echo "Next: Pass the updated .zkey files to the next contributor:"
    echo "  ./run-ceremony.sh phase2-contribute $((contrib_num + 1)) \"<name>\""
  else
    echo "All 5 Phase 2 contributions done. Next:"
    echo "  ./run-ceremony.sh phase2-finalize"
  fi
}

cmd_phase2_finalize() {
  check_prerequisites

  log "Finalizing Phase 2"

  for entry in "${CIRCUITS[@]}"; do
    parse_circuit "$entry"

    # Find the latest contribution zkey for this circuit.
    local latest_zkey
    latest_zkey=$(ls -1 "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_"*.zkey 2>/dev/null \
      | grep -v 'final' | grep -v 'beacon' | sort | tail -1)

    if [[ -z "$latest_zkey" ]]; then
      echo "WARNING: No Phase 2 .zkey files found for ${CIRCUIT_NAME}, skipping." >&2
      continue
    fi

    echo "Latest contribution for ${CIRCUIT_NAME}: $latest_zkey"

    # ------------------------------------------------------------------
    # Apply random beacon to this circuit's zkey
    # ------------------------------------------------------------------
    local beacon_zkey="${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_beacon.zkey"
    local final_zkey="${OUTPUT_DIR}/${CIRCUIT_NAME}_final.zkey"
    local vkey="${OUTPUT_DIR}/${CIRCUIT_NAME}_verification_key.json"

    log "Applying beacon to ${CIRCUIT_NAME}"

    $SNARKJS zkey beacon \
      "$latest_zkey" "$beacon_zkey" \
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" 10 \
      -n="Final Beacon" \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_beacon.log"

    # ------------------------------------------------------------------
    # Copy final zkey to output
    # ------------------------------------------------------------------
    cp "$beacon_zkey" "$final_zkey"
    echo "  Final zkey: $final_zkey"

    # ------------------------------------------------------------------
    # Export verification key
    # ------------------------------------------------------------------
    log "Exporting verification key for ${CIRCUIT_NAME}"

    $SNARKJS zkey export verificationkey \
      "$final_zkey" "$vkey" \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_export_vkey.log"

    echo "  Verification key: $vkey"
  done

  # ------------------------------------------------------------------
  # Verify final zkeys against R1CS
  # ------------------------------------------------------------------
  log "Verifying final .zkey files"

  for entry in "${CIRCUITS[@]}"; do
    parse_circuit "$entry"

    local r1cs="${BUILD_DIR}/${CIRCUIT_NAME}.r1cs"
    local final_zkey="${OUTPUT_DIR}/${CIRCUIT_NAME}_final.zkey"
    local final_ptau="${TRANSCRIPT_DIR}/pot${PTAU_POWER}_final.ptau"

    if [[ ! -f "$final_zkey" ]]; then
      continue
    fi

    echo "Verifying ${CIRCUIT_NAME}_final.zkey..."
    $SNARKJS zkey verify \
      "$r1cs" "$final_ptau" "$final_zkey" \
      2>&1 | tee "${TRANSCRIPT_DIR}/${CIRCUIT_NAME}_final_verify.log"
  done

  echo ""
  log "Ceremony Complete"
  echo ""
  echo "Output artifacts are in: ${OUTPUT_DIR}/"
  ls -la "$OUTPUT_DIR/"
  echo ""
  echo "To verify the full transcript independently:"
  echo "  ./verify-ceremony.sh"
  echo ""
  echo "IMPORTANT: Publish the full transcript/ directory along with"
  echo "contributor attestations and the beacon source."
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

case "${1:-help}" in
  init)
    cmd_init
    ;;
  phase1-contribute)
    cmd_phase1_contribute "${2:-}" "${3:-}"
    ;;
  phase1-verify)
    cmd_phase1_verify
    ;;
  phase1-finalize)
    cmd_phase1_finalize
    ;;
  phase2-contribute)
    cmd_phase2_contribute "${2:-}" "${3:-}"
    ;;
  phase2-finalize)
    cmd_phase2_finalize
    ;;
  help|--help|-h)
    echo "Usage: $0 <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  init                              Initialize ceremony (compile circuits, start Phase 1)"
    echo "  phase1-contribute <N> \"<name>\"    Add Phase 1 contribution #N"
    echo "  phase1-verify                     Verify all Phase 1 contributions"
    echo "  phase1-finalize                   Apply beacon and prepare Phase 2"
    echo "  phase2-contribute <N> \"<name>\"    Add Phase 2 contribution #N for all circuits"
    echo "  phase2-finalize                   Apply beacon, export final keys"
    echo "  help                              Show this help message"
    echo ""
    echo "Typical ceremony flow:"
    echo "  1. Coordinator: ./run-ceremony.sh init"
    echo "  2. Contributor 1: ./run-ceremony.sh phase1-contribute 1 \"Alice\""
    echo "  3. Contributor 2: ./run-ceremony.sh phase1-contribute 2 \"Bob\""
    echo "  4. Contributor 3: ./run-ceremony.sh phase1-contribute 3 \"Carol\""
    echo "  5. Coordinator: ./run-ceremony.sh phase1-finalize"
    echo "  6. Contributor 1: ./run-ceremony.sh phase2-contribute 1 \"Alice\""
    echo "  7. Contributor 2: ./run-ceremony.sh phase2-contribute 2 \"Bob\""
    echo "  8. Contributor 3: ./run-ceremony.sh phase2-contribute 3 \"Carol\""
    echo "  9. Coordinator: ./run-ceremony.sh phase2-finalize"
    echo " 10. Anyone: ./verify-ceremony.sh"
    ;;
  *)
    echo "ERROR: Unknown command: $1" >&2
    echo "Run '$0 help' for usage." >&2
    exit 1
    ;;
esac
