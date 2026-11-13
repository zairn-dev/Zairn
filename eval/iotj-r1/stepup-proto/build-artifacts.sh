#!/usr/bin/env bash
# Builds the Zairn-ZKP artifacts for the step-up prototype into artifacts/.
# Single-party Groth16 setup: fine for a prototype, not for deployment.
# Needs pot10_final.ptau (2^10 powers of tau); pass its path as $1.
set -euo pipefail
cd "$(dirname "$0")"
BIN=../../../packages/geo-drop/node_modules/.bin
PTAU="${1:?usage: build-artifacts.sh path/to/pot10_final.ptau}"
mkdir -p artifacts
cp ../../../packages/geo-drop/circuits/zairn_zkp.circom artifacts/
cp "$PTAU" artifacts/pot10_final.ptau
cd artifacts
# circom2 (WASI) needs a relative output path.
"../$BIN/circom2" zairn_zkp.circom --r1cs --wasm --sym -o .
"../$BIN/snarkjs" r1cs info zairn_zkp.r1cs
"../$BIN/snarkjs" groth16 setup zairn_zkp.r1cs pot10_final.ptau zairn_zkp_0000.zkey
"../$BIN/snarkjs" zkey contribute zairn_zkp_0000.zkey zairn_zkp_final.zkey --name="iotj-r1 stepup prototype" -e="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
"../$BIN/snarkjs" zkey export verificationkey zairn_zkp_final.zkey zairn_zkp_vkey.json
rm -f zairn_zkp_0000.zkey
