# Multi-Party Trusted Setup Ceremony for Zairn ZKP Circuits

This directory contains scripts for running a multi-party trusted setup ceremony
for the Zairn ZKP Groth16 circuits. The ceremony produces proving keys (`.zkey`)
and verification keys (`verification_key.json`) that can be used in production.

## Background

Groth16 requires a **circuit-specific trusted setup**. The security guarantee is
that the toxic waste (tau) is destroyed as long as **at least one** contributor
is honest and discards their randomness. A multi-party ceremony with independent
contributors makes this assumption practical.

The ceremony has two phases:

1. **Phase 1 (Powers of Tau)**: Curve-independent, reusable across circuits.
   Generates structured reference string (SRS) parameters for BN128.
2. **Phase 2 (Circuit-specific)**: Each circuit's R1CS is combined with the
   Phase 1 output. Each contributor adds their own randomness.

## Circuits Included

| Circuit | File | Purpose | Production |
|---------|------|---------|------------|
| `zairn_zkp` | `zairn_zkp.circom` | Context-bound proximity proof | Yes |
| `region_zkp` | `region_zkp.circom` | Point-in-polygon containment proof | Yes |
| `proximity` | `proximity.circom` | Original proximity proof (legacy) | No |
| `sound_geo_only` | `sound_geo_only.circom` | Evaluation baseline (no context binding) | No |

The ceremony script processes **all four** circuits. In production, only
`zairn_zkp` and `region_zkp` ceremony outputs should be deployed.

## Requirements

### Software

- **Node.js** >= 18
- **snarkjs** >= 0.7.0 (`npx snarkjs` or globally installed)
- **circom** >= 2.1.0 (for compiling circuits)
- A cryptographically secure random source (`/dev/urandom`)

### Contributors

The ceremony requires **3 to 5 independent contributors**. Each contributor:

- Must run the contribution step on their own machine
- Must use their own source of randomness (entropy)
- Must not share their random input with anyone
- Should ideally be from different organizations or geographic locations
- Must attest to having deleted their randomness after contributing

### Disk Space

Approximately 500 MB for intermediate `.ptau` and `.zkey` files.

## Running the Ceremony

### Step 1: Coordinator Initializes

The ceremony coordinator compiles the circuits and starts Phase 1:

```bash
cd packages/geo-drop/circuits/ceremony
chmod +x run-ceremony.sh verify-ceremony.sh
./run-ceremony.sh init
```

This will:
- Compile all `.circom` files to R1CS + WASM
- Generate the initial Powers of Tau file (`pot14_0000.ptau`)
- Prepare the working directory

### Step 2: Phase 1 Contributions (Powers of Tau)

Each contributor runs the Phase 1 contribution step **sequentially**. The
coordinator passes the latest `.ptau` file to the next contributor.

**Contributor 1:**
```bash
./run-ceremony.sh phase1-contribute 1 "Contributor Name"
# Input: pot14_0000.ptau
# Output: pot14_0001.ptau
```

**Contributor 2:**
```bash
./run-ceremony.sh phase1-contribute 2 "Contributor Name"
# Input: pot14_0001.ptau
# Output: pot14_0002.ptau
```

Continue for each contributor (up to 5). Each contributor should type random
text when prompted by snarkjs as additional entropy.

### Step 3: Finalize Phase 1

After all Phase 1 contributions:

```bash
./run-ceremony.sh phase1-finalize
```

This applies a random beacon (using a publicly verifiable value such as
a Bitcoin block hash) and prepares the Phase 2 input file.

### Step 4: Phase 2 Contributions (Circuit-Specific)

Phase 2 runs for each circuit independently. Each contributor adds randomness
to every circuit's `.zkey` file.

**Contributor 1:**
```bash
./run-ceremony.sh phase2-contribute 1 "Contributor Name"
```

**Contributor 2:**
```bash
./run-ceremony.sh phase2-contribute 2 "Contributor Name"
```

Continue for all contributors.

### Step 5: Finalize Phase 2 and Export Keys

```bash
./run-ceremony.sh phase2-finalize
```

This applies a random beacon to each circuit's `.zkey` and exports:
- Final `.zkey` proving keys
- `verification_key.json` files

### Step 6: Verify the Entire Ceremony

```bash
./verify-ceremony.sh
```

This verifies every contribution in both Phase 1 and Phase 2, ensuring the
transcript is intact and all contributions are valid.

## Output Artifacts

After a successful ceremony, the `output/` directory contains:

```
output/
  zairn_zkp_final.zkey          # Proving key for zairn_zkp
  zairn_zkp_verification_key.json
  region_zkp_final.zkey         # Proving key for region_zkp
  region_zkp_verification_key.json
  proximity_final.zkey          # Proving key for proximity (legacy)
  proximity_verification_key.json
  sound_geo_only_final.zkey     # Proving key for sound_geo_only (baseline)
  sound_geo_only_verification_key.json
```

### Deploying Artifacts

1. Upload `.zkey` and `.wasm` files to your CDN / artifacts server.
2. Store `verification_key.json` in the application configuration
   (e.g., `proof_config.requirements[].params.verification_key` in GeoDrops).
3. Publish the full ceremony transcript (all intermediate `.ptau` and `.zkey`
   files) so anyone can verify the setup independently.

## Verification by Third Parties

Anyone can verify the ceremony transcript:

```bash
# Clone the repo, install dependencies, then:
cd packages/geo-drop/circuits/ceremony
./verify-ceremony.sh
```

The verification script checks:
- All Phase 1 contributions are valid
- The Phase 1 beacon was applied correctly
- All Phase 2 contributions for each circuit are valid
- The Phase 2 beacon was applied correctly
- The final `.zkey` matches the exported verification key

## Security Considerations

- **Entropy**: Each contributor MUST use a unique, high-quality entropy source.
  Do not reuse entropy across contributions or share it.
- **Communication**: Transfer `.ptau` and `.zkey` files over authenticated
  channels (e.g., GPG-signed checksums, HTTPS).
- **Deletion**: After contributing, each participant must securely delete their
  random input. Use `shred` or equivalent.
- **Transparency**: Publish the full transcript, contributor attestations, and
  the beacon source (e.g., Bitcoin block hash at a predetermined height).
- **1-of-N security**: The setup is secure as long as at least one contributor
  honestly discards their randomness.

## Ceremony Log Format

Each contribution is logged with:
- Contributor name
- Contribution hash (printed by snarkjs)
- Timestamp
- Machine description (optional but recommended)

Contributors should publish their contribution hash publicly (e.g., on social
media or a signed attestation) so the transcript can be independently verified.

## Troubleshooting

- **"circuit too large for ptau"**: Increase the Powers of Tau size. The default
  is `2^14` (16384 constraints). For larger circuits, use `2^16` or higher.
- **snarkjs not found**: Ensure snarkjs is installed (`pnpm install` in the
  workspace root, or `npm install -g snarkjs`).
- **circom not found**: Install circom2 following https://docs.circom.io/getting-started/installation/
