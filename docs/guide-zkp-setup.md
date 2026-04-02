# ZKP Setup Guide

This guide covers setting up zero-knowledge proofs for Zairn: both the original proximity proofs (GeoDrop) and the newer ZKLS (Zero-Knowledge Location States).

## Overview

Zairn uses **Groth16** proofs on the **BN128** curve via **snarkjs** and **circom**.

| Circuit | Constraints | Proves | Use case |
|---------|------------|--------|----------|
| Proximity | 474 | "I am within R meters of point P" | GeoDrop unlock |
| Grid Membership | 175 | "I am in grid cell G" | ZKLS presence sharing |
| Departure | 418 | "I am >D meters from home" | ZKLS departure notification |

## Quick Start (Development)

Pre-compiled WASM and development zkeys are included in the repo:

```ts
import { generateGridMembershipProof, verifyGridMembershipProof } from '@zairn/geo-drop';

const proof = await generateGridMembershipProof(
  userLat, userLon,
  500,        // grid size in meters
  user.id,    // grid seed (per-user)
  {
    wasmUrl: '/circuits/wasm/grid_membership_zkp.wasm',
    zkeyUrl: '/circuits/grid_membership_zkp_final.zkey',
  },
);

const vkey = await fetch('/circuits/grid_membership_zkp_vkey.json').then(r => r.json());
const valid = await verifyGridMembershipProof(proof.proof, proof.publicSignals, vkey);
```

## Production Setup

### 1. Multi-Party Ceremony (REQUIRED)

The included `.zkey` files are from a **single-contributor ceremony** and are **NOT safe for production**. A malicious ceremony participant could forge proofs.

Run a multi-party ceremony with ≥3 contributors:

```bash
cd packages/geo-drop/circuits

# Phase 1: Use existing Powers of Tau (shared across circuits)
# pot10_final.ptau is already included

# Phase 2: Circuit-specific setup with multiple contributors
snarkjs groth16 setup build/grid_membership_zkp.r1cs pot10_final.ptau grid_membership_zkp_0000.zkey

# Contributor 1
snarkjs zkey contribute grid_membership_zkp_0000.zkey grid_membership_zkp_0001.zkey \
  --name="Contributor 1" -v

# Contributor 2
snarkjs zkey contribute grid_membership_zkp_0001.zkey grid_membership_zkp_0002.zkey \
  --name="Contributor 2" -v

# Contributor 3
snarkjs zkey contribute grid_membership_zkp_0002.zkey grid_membership_zkp_final.zkey \
  --name="Contributor 3" -v

# Export verification key
snarkjs zkey export verificationkey grid_membership_zkp_final.zkey grid_membership_zkp_vkey.json

# Verify the ceremony
snarkjs zkey verify build/grid_membership_zkp.r1cs pot10_final.ptau grid_membership_zkp_final.zkey
```

Repeat for `departure_zkp` circuit.

### 2. Deploying Artifacts

| File | Where to deploy | Size |
|------|----------------|------|
| `*.wasm` | CDN or app bundle | 40-52 KB |
| `*_final.zkey` | CDN (fetched at proof time) | 100-230 KB |
| `*_vkey.json` | Server or client | 4 KB |

The WASM and zkey are fetched lazily — they're only downloaded when the first proof is generated.

### 3. Runtime Warning

When using `{ production: true }`, the SDK warns if the zkey appears to be from a single-contributor ceremony:

```ts
const proof = await generateGridMembershipProof(
  lat, lon, gridSize, seed, artifacts, context,
  { production: true },  // Enables ceremony check
);
```

## ZKLS: Zero-Knowledge Location States

ZKLS replaces coordinate sharing with verifiable state proofs:

```ts
import {
  createHomeCommitment,
  generateDepartureProof,
  computeGridParams,
} from '@zairn/geo-drop';

// One-time: create home commitment (salt stays on device!)
const { commitment, salt } = createHomeCommitment(homeLat, homeLon);
// Store `commitment` on server, `salt` in device secure storage

// At share time: prove "I have left home" without revealing where home is
const departureProof = await generateDepartureProof(
  currentLat, currentLon,
  homeLat, homeLon,
  { commitment, salt },
  1000,  // minimum distance in meters
  artifacts,
);
```

## Performance

Benchmarked on Node.js WASM (desktop):

| Circuit | Prove (P50) | Verify (P50) |
|---------|------------|-------------|
| Grid Membership (175c) | 66 ms | 10 ms |
| Departure (418c) | 81 ms | 9 ms |

Mobile estimates: ~20-40 ms (iPhone), ~50-80 ms (Android mid-range).

## Troubleshooting

- **"snarkjs is required"**: Install snarkjs as an optional dependency: `pnpm add snarkjs`
- **WASM not found**: Ensure WASM files are in `circuits/wasm/` or served from your CDN
- **Proof verification fails**: Check that the verification key matches the zkey used for proving. Mismatched keys (e.g., after ceremony re-run) will always fail.
