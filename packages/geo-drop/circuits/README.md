# ZK Proximity Proof Circuit

Circom circuit for proving proximity to a location without revealing exact coordinates.

## Prerequisites

```bash
# Install circom compiler
npm install -g circom@2.1.0

# Install snarkjs
npm install -g snarkjs
```

## Build Steps

### 1. Compile Circuit

```bash
circom proximity.circom --r1cs --wasm --sym -o build/
```

### 2. Trusted Setup (Powers of Tau)

For development/testing, use a small ceremony:

```bash
# Phase 1: Powers of Tau (BN128, 2^12 constraints is sufficient)
snarkjs powersoftau new bn128 12 pot12_0000.ptau -v
snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name="First contribution" -v
snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau -v

# Phase 2: Circuit-specific setup
snarkjs groth16 setup build/proximity.r1cs pot12_final.ptau proximity_0000.zkey
snarkjs zkey contribute proximity_0000.zkey proximity_final.zkey --name="First contribution" -v
snarkjs zkey export verificationkey proximity_final.zkey verification_key.json
```

For production, use a multi-party ceremony (e.g., Hermez ceremony ptau files from
https://github.com/iden3/snarkjs#7-prepare-phase-2).

### 3. Output Artifacts

| File | Purpose | Where to deploy |
|------|---------|----------------|
| `build/proximity_js/proximity.wasm` | Circuit WASM | CDN / artifacts server |
| `proximity_final.zkey` | Proving key | CDN / artifacts server |
| `verification_key.json` | Verification key | Stored in drop's `proof_config.requirements[].params.verification_key` |

### 4. Usage in GeoDrop SDK

```typescript
import { generateProximityProof, verifyProximityProof } from '@zairn/geo-drop';

// Prover (client-side)
const { proof, publicSignals } = await generateProximityProof(
  userLat, userLon,
  drop.lat, drop.lon,
  drop.unlock_radius_meters,
  { artifactsBaseUrl: 'https://cdn.example.com/zkp/' }
);

// Verifier (server or client)
const valid = await verifyProximityProof(proof, publicSignals, verificationKey);
```

## Circuit Details

- **Curve**: BN128 (alt_bn128)
- **Protocol**: Groth16
- **Arithmetic**: Fixed-point integers (scale ×1e6, ~0.11m resolution)
- **Latitude correction**: cos(lat) scaling on longitude delta
- **Constraints**: ~5 (lightweight circuit, fast proving)
