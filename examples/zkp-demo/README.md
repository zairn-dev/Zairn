# ZKP Proximity Proof Demo

Interactive demo of zero-knowledge location proofs from `@zairn/geo-drop`.

Demonstrates:
- Fixed-point coordinate encoding (×1e6)
- cos(lat) longitude correction
- Distance-squared computation (circuit logic)
- Public signal validation

## Setup

```bash
# From the repo root
pnpm install

# Start the demo
pnpm --filter zkp-demo-example dev
```

No Supabase or circuit artifacts needed — this demo uses pure math functions only.

## What it shows

### The Math

The Groth16 circuit proves: `dLat² + (dLon × cos(lat))² ≤ R²`

1. **Fixed-point encoding**: Converts degrees to integers (×1e6 ≈ 0.11m resolution)
2. **Longitude correction**: At higher latitudes, longitude degrees are shorter — multiply by cos(lat)
3. **Distance check**: Compare squared distance against squared radius (avoids square root)

### Privacy

- **Private inputs** (never leave the client): user's latitude, longitude
- **Public inputs** (visible to verifier): drop lat/lon, radius², cos(lat)
- **What the verifier learns**: only "the prover is within R meters of the drop"
- **What the verifier does NOT learn**: the prover's exact coordinates

### Full Proof Flow

For actual ZK proof generation (not shown in this math demo), see:
- `generateProximityProof()` in `@zairn/geo-drop`
- `circuits/README.md` for circuit compilation and trusted setup
