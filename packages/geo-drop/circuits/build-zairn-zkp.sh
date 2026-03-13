#!/usr/bin/env bash
set -euo pipefail

CIRCUIT="${1:-zairn_zkp}"
PTAU="pot10_final.ptau"
BUILD_DIR="build"
COMPILE_ONLY="${COMPILE_ONLY:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve local binaries from node_modules
LOCAL_BIN="$(dirname "$SCRIPT_DIR")/node_modules/.bin"
find_cmd() {
  for name in "$@"; do
    if command -v "$name" &>/dev/null; then echo "$name"; return; fi
    if [ -x "$LOCAL_BIN/$name" ]; then echo "$LOCAL_BIN/$name"; return; fi
  done
  echo "Error: required command not found. Tried: $*" >&2; exit 1
}

CIRCOM=$(find_cmd circom2 circom)
SNARKJS=$(find_cmd snarkjs)

if [ ! -f "${CIRCUIT}.circom" ]; then
  echo "Error: circuit file not found: ${CIRCUIT}.circom" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

# Phase 1: Powers of Tau (if not present)
if [ ! -f "$PTAU" ]; then
  echo "Generating Powers of Tau ceremony..."
  "$SNARKJS" powersoftau new bn128 10 pot10_0000.ptau -v
  "$SNARKJS" powersoftau contribute pot10_0000.ptau pot10_0001.ptau \
    --name="Zairn local contribution" -e=zairn-zkp
  "$SNARKJS" powersoftau prepare phase2 pot10_0001.ptau "$PTAU" -v
fi

# Compile circuit
echo "Compiling ${CIRCUIT}.circom..."
"$CIRCOM" "${CIRCUIT}.circom" --r1cs --wasm --sym -o "$BUILD_DIR"

echo "Compiled circuit artifacts:"
echo "  R1CS: ${BUILD_DIR}/${CIRCUIT}.r1cs"
echo "  WASM: ${BUILD_DIR}/${CIRCUIT}_js/${CIRCUIT}.wasm"
echo "  SYM:  ${BUILD_DIR}/${CIRCUIT}.sym"

if [ -n "$COMPILE_ONLY" ]; then
  echo "Compile-only mode — skipping trusted setup."
  exit 0
fi

# Phase 2: Circuit-specific setup
echo "Running Groth16 setup..."
"$SNARKJS" groth16 setup "${BUILD_DIR}/${CIRCUIT}.r1cs" "$PTAU" "${CIRCUIT}_0000.zkey"
"$SNARKJS" zkey contribute "${CIRCUIT}_0000.zkey" "${CIRCUIT}_final.zkey" \
  --name="Initial contribution" -e=zairn-zkp
"$SNARKJS" zkey export verificationkey "${CIRCUIT}_final.zkey" verification_key.json

echo "Built proving artifacts:"
echo "  ZKey: ${CIRCUIT}_final.zkey"
echo "  VKey: verification_key.json"
