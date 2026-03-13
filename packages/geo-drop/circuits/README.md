# ZK Proximity Proof Circuits

Circom circuits for proving proximity to a location without revealing exact coordinates.

The package currently includes:

- `proximity.circom`: original proximity-only statement
- `zairn_zkp.circom`: context-bound Zairn-ZKP statement with drop/session binding

## Prerequisites

```bash
pnpm install
```

The workspace installs `circom2` and `snarkjs` locally for `@zairn/geo-drop`.

## Build Steps

### 1. Compile Circuit

```bash
# Original circuit
circom proximity.circom --r1cs --wasm --sym -o build/

# Context-bound Zairn-ZKP circuit
circom zairn_zkp.circom --r1cs --wasm --sym -o build/
```

### 2. Trusted Setup

For development and testing, the current circuit fits within a small BN128 ceremony:

```bash
# Phase 1: Powers of Tau
snarkjs powersoftau new bn128 10 pot10_0000.ptau -v
snarkjs powersoftau contribute pot10_0000.ptau pot10_0001.ptau --name="First contribution" -v
snarkjs powersoftau prepare phase2 pot10_0001.ptau pot10_final.ptau -v

# Phase 2: Circuit-specific setup
snarkjs groth16 setup build/zairn_zkp.r1cs pot10_final.ptau zairn_zkp_0000.zkey
snarkjs zkey contribute zairn_zkp_0000.zkey zairn_zkp_final.zkey --name="First contribution" -v
snarkjs zkey export verificationkey zairn_zkp_final.zkey verification_key.json
```

For production, use a multi-party ceremony and publish the ceremony transcript with the final proving key.

### 3. Output Artifacts

| File | Purpose | Where to deploy |
|------|---------|----------------|
| `build/zairn_zkp_js/zairn_zkp.wasm` | Circuit WASM | CDN / artifacts server |
| `zairn_zkp_final.zkey` | Proving key | CDN / artifacts server |
| `verification_key.json` | Verification key | Stored in drop's `proof_config.requirements[].params.verification_key` |

### 4. Workspace Scripts

```bash
pnpm --filter @zairn/geo-drop run zkp:compile
pnpm --filter @zairn/geo-drop run zkp:build
pnpm --filter @zairn/geo-drop run zkp:witness
pnpm --filter @zairn/geo-drop run zkp:prove
pnpm --filter @zairn/geo-drop run zkp:verify
```

`zkp:witness`, `zkp:prove`, and `zkp:verify` use the sample input in
`example-zairn-zkp-input.json` and write outputs into `build/`.

### 5. Usage in GeoDrop SDK

```typescript
import { generateZairnZkpProof, verifyProximityProof } from '@zairn/geo-drop';

const { proof, publicSignals, statement } = await generateZairnZkpProof(
  userLat, userLon,
  drop.lat, drop.lon,
  drop.unlock_radius_meters,
  {
    dropId: drop.id,
    policyVersion: '1',
    epoch: '2026-03-13T10',
    serverNonce: nonceFromServer,
  },
  { artifactsBaseUrl: 'https://cdn.example.com/zkp/' }
);

const valid = await verifyProximityProof(proof, publicSignals, verificationKey);
```

## Circuit Details

- **Curve**: BN128 (`alt_bn128`)
- **Protocol**: Groth16
- **Arithmetic**: Fixed-point integers (scale ×1e6, ~0.11m resolution)
- **Latitude correction**: cosine scaling on longitude delta
- **Context binding**: `drop_id`, `policy_version`, `epoch`, and `server_nonce` are bound through public statement values
