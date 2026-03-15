# @zairn/geo-drop

TypeScript reference implementation of the **GeoDrop Protocol**.

An open protocol for creating, discovering, and unlocking Location-Bound Content — digital content that is cryptographically locked to a physical location. Content is encrypted and stored on IPFS; accessing it requires proof of physical presence at the designated location. No single app or service dependency.

> **Protocol Spec:** [`protocol/SPEC.md`](./protocol/SPEC.md)
> **JSON Schema:** [`protocol/drop-metadata.schema.json`](./protocol/drop-metadata.schema.json)
> **Contract Interface:** [`contracts/IGeoDropRegistry.sol`](./contracts/IGeoDropRegistry.sol)

## Installation

```bash
pnpm add @zairn/geo-drop @supabase/supabase-js
```

## Setup

### Database

Apply `database/schema.sql` to Supabase:

```bash
supabase db push
```

### Edge Function (for image-based verification)

```bash
supabase functions deploy image-proof
```

## Quick Start

```typescript
import { createGeoDrop } from '@zairn/geo-drop';

const geo = createGeoDrop({
  supabaseUrl: 'https://xxx.supabase.co',
  supabaseAnonKey: 'eyJ...',
  ipfs: {
    gateway: 'https://w3s.link/ipfs',
    pinningService: 'pinata',
    pinningApiKey: 'your-api-key',
  },
});

// Create a drop
const drop = await geo.createDrop(
  {
    title: 'Secret Message',
    content_type: 'text',
    lat: 35.6812,
    lon: 139.7671,
    unlock_radius_meters: 30,
  },
  'This content is only accessible at this location!'
);

// Find nearby drops
const nearby = await geo.findNearbyDrops(35.6812, 139.7671, 500);

// Unlock
const { content, claim } = await geo.unlockDrop(
  drop.id, 35.6813, 139.7672, 10
);
```

## Verification Methods

Drops can be protected with multiple verification methods.

| Method | Description | `params` |
|--------|-------------|----------|
| `gps` | GPS proximity check (default) | `{}` |
| `secret` | Secret value matching (QR/BLE/WiFi/NFC) | `{ secret, label? }` |
| `ar` | DINOv2 image feature comparison | `{ reference_embedding, similarity_threshold? }` |
| `zkp` | Zero-knowledge proof of proximity (Groth16) | `{ verification_key, artifacts_url? }` |
| `zkp-region` | Zero-knowledge polygon containment (Groth16) | `{ verification_key, polygon, artifacts_url? }` |
| `custom` | Custom verifier | `{ verifier_id, ... }` |

### Multi-factor verification

```typescript
// Require both GPS and QR code
const drop = await geo.createDrop(
  {
    title: 'Treasure',
    content_type: 'text',
    lat: 35.6812,
    lon: 139.7671,
    proof_config: {
      mode: 'all', // AND mode ('any' for OR)
      requirements: [
        { method: 'gps', params: {} },
        { method: 'secret', params: { secret: 'CAFE-1234', label: 'QR Code' } },
      ],
    },
  },
  'Found the treasure!'
);

// Submit proofs at unlock
const { content } = await geo.unlockDrop(
  drop.id, lat, lon, accuracy,
  undefined, // password
  [{ method: 'secret', data: { secret: 'CAFE-1234' } }]
);
```

### Image verification (AR)

Server-side DINOv2 feature vector comparison via Edge Function.

```typescript
// 1. Extract reference image embedding
const { embedding } = await geo.extractImageEmbedding(referenceImageBase64);

// 2. Set during drop creation
const drop = await geo.createDrop(
  {
    title: 'Landmark Drop',
    content_type: 'text',
    lat: 35.6812,
    lon: 139.7671,
    proof_config: {
      mode: 'all',
      requirements: [
        { method: 'gps', params: {} },
        { method: 'ar', params: { reference_embedding: embedding, similarity_threshold: 0.70 } },
      ],
    },
  },
  'You found the landmark!'
);

// 3. Unlock with a photo taken on-site
const { content } = await geo.unlockDrop(
  drop.id, lat, lon, accuracy,
  undefined,
  [{ method: 'ar', data: { image: capturedImageBase64 } }]
);
```

### Zero-Knowledge Proof of Location (ZKP)

Prove proximity without revealing exact coordinates. Uses Groth16 (snarkjs) with a circom circuit.

```typescript
import { generateProximityProof } from '@zairn/geo-drop';

// 1. Create a drop with ZKP verification
const drop = await geo.createDrop(
  {
    title: 'Privacy-Preserving Drop',
    content_type: 'text',
    lat: 35.6812,
    lon: 139.7671,
    unlock_radius_meters: 50,
    proof_config: {
      mode: 'all',
      requirements: [
        {
          method: 'zkp',
          params: {
            verification_key: verificationKeyJson, // from trusted setup
            artifacts_url: 'https://cdn.example.com/zkp/',
          },
        },
      ],
    },
  },
  'Only provably-nearby users can see this!'
);

// 2. Generate ZK proof on client (coordinates stay private)
const { proof, publicSignals } = await generateProximityProof(
  userLat, userLon,
  drop.lat, drop.lon,
  drop.unlock_radius_meters,
  { artifactsBaseUrl: 'https://cdn.example.com/zkp/' }
);

// 3. Unlock with ZK proof (server never learns exact coordinates)
const { content } = await geo.unlockDrop(
  drop.id, 0, 0, 0, // lat/lon/accuracy not needed for ZKP
  undefined,
  [{ method: 'zkp', data: { proof, publicSignals } }]
);
```

**Circuit details:** See [`circuits/README.md`](./circuits/README.md) for build & trusted setup instructions.

**How it works:**
- Fixed-point arithmetic (×1e6 ≈ 0.11m resolution) with cos(lat) longitude correction
- Proves `dLat² + (dLon × cos(lat))² ≤ R²` without revealing (userLat, userLon)
- Public signals are validated against drop parameters to prevent proof reuse
- snarkjs is an optional dependency — only loaded when ZKP is actually used

### Custom verifier

```typescript
const geo = createGeoDrop({
  supabaseUrl: '...',
  supabaseAnonKey: '...',
  verifiers: {
    'my-nfc': (req, sub, drop) => ({
      method: 'custom',
      verified: sub.data.tag_id === req.params.expected_tag,
      details: { tag_id: sub.data.tag_id },
    }),
  },
});
```

## Persistence (DB-Independent Recovery)

Choose how durable your drops are. Even after service shutdown, drops can be rediscovered.

| Level | Cost | Durability | Description |
|-------|------|------------|-------------|
| `db-only` | Free | DB-dependent | Default. Data lost if DB goes down |
| `ipfs` | Pinning fees | Requires continued pinning | Metadata also stored on IPFS |
| `onchain` | Gas (<$0.01 on L2) | Semi-permanent | Metadata CID anchored on-chain |
| `ipfs+onchain` | Both | Semi-permanent | Explicitly both |

### Setup

```typescript
const geo = createGeoDrop({
  supabaseUrl: '...',
  supabaseAnonKey: '...',
  persistence: {
    level: 'ipfs+onchain',
    chain: {
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0x...',
      signer: walletClient, // ethers.js Signer or viem WalletClient
    },
  },
});
```

### Per-drop persistence

```typescript
const drop = await geo.createDrop(
  {
    title: 'Time Capsule',
    content_type: 'text',
    lat: 35.6812,
    lon: 139.7671,
    persistence: 'ipfs+onchain',
    // Encrypt metadata itself for private drops
    recoverySecret: 'my-secret-phrase',
  },
  'Message from 2026!'
);
// drop.metadata_cid  → IPFS metadata CID
// drop.chain_tx_hash → On-chain transaction hash
```

### Recovery after DB loss

```typescript
// Method 1: Direct recovery with known CID
const recovered = await geo.recoverDrop('QmXxx...', 'my-secret-phrase');
const content = await geo.decryptRecoveredDrop(recovered);

// Method 2: Discover via on-chain index at a location
const drops = await geo.discoverDropsByLocation(35.6812, 139.7671);
for (const drop of drops) {
  console.log(drop.metadata.title, drop.metadataCid);
}
```

### Smart Contract

`contracts/GeoDropRegistry.sol` — Append-only EVM registry.

- `registerDrop(bytes7 geohash, string metadataCid)` — Register a CID
- `getDropCids(bytes7 geohash)` — Get all CIDs for a geohash (free read)
- `getDropCidsPaginated(bytes7, uint256, uint256)` — Paginated retrieval

Recommended: deploy on L2 (Base, Polygon, Arbitrum). Gas < $0.01 per registration.

## API Reference

### Drop Management
- `createDrop(data, content)` — Create a drop (encrypts content → IPFS)
- `getDrop(dropId)` — Get a drop
- `getMyDrops(options?)` — List own drops
- `deleteDrop(dropId)` — Soft-delete a drop

### Discovery & Unlock
- `findNearbyDrops(lat, lon, radius?)` — Search nearby drops
- `unlockDrop(dropId, lat, lon, accuracy, password?, proofs?)` — Unlock & decrypt content

### Verification
- `getProofConfig(dropId)` — Get drop's verification config
- `registerVerifier(id, fn)` — Register a custom verifier
- `extractImageEmbedding(base64)` — Extract image feature vector
- `verifyImageProof(base64, dropId, threshold?)` — Image verification (direct call)

### Sharing
- `shareDrop(dropId, userIds)` — Share a private drop
- `unshareDrop(dropId, userId)` — Revoke share
- `getSharedDrops()` — List drops shared with you

### Claims & Stats
- `getDropClaims(dropId)` — List claims for a drop
- `getMyClaims(options?)` — List own claims
- `getMyStats()` — Get statistics

### Realtime
- `subscribeNearbyDrops(lat, lon, radius, callback)` — Real-time notifications for new drops

### DB-Independent Recovery
- `recoverDrop(metadataCid, recoverySecret?)` — Recover from a known CID
- `discoverDropsByLocation(lat, lon, precision?)` — Discover via on-chain index
- `decryptRecoveredDrop(recovered)` — Decrypt recovered drop content

### Utilities
- `encodeGeohash(lat, lon, precision?)` / `decodeGeohash(hash)`
- `calculateDistance(lat1, lon1, lat2, lon2)` — Haversine distance (m)
- `verifyLocation(dropId, lat, lon, accuracy)` — Standalone geofence verification
- `generateNftMetadata(drop, imageUrl?)` — Generate NFT metadata
- `uploadToIpfs(content)` / `fetchFromIpfs(cid)` — Direct IPFS operations

## Protocol & Interoperability

This package is a reference implementation of **GeoDrop Protocol v1**.

The protocol consists of three layers:

```
┌─────────────────────────────────────────────┐
│  Application Layer                          │  ← Build anything
│  (Geocaching, AR games, NFT markets, etc.)  │
├─────────────────────────────────────────────┤
│  Protocol Layer (GeoDrop Protocol)          │  ← Interoperable by spec
│  - DropMetadataDocument (JSON)              │
│  - Encryption (AES-GCM + PBKDF2)           │
│  - Verification (GPS/Secret/AR/ZKP/Custom)   │
│  - On-chain Registry (IGeoDropRegistry)     │
├─────────────────────────────────────────────┤
│  Storage Layer                              │  ← IPFS + EVM chain
│  (IPFS, Filecoin, Arweave, EVM L2)         │
└─────────────────────────────────────────────┘
```

Different applications (geocaching apps, AR games, regional NFT markets, etc.) publishing drops on the same protocol can **discover and unlock each other's content**.

Details: [`protocol/SPEC.md`](./protocol/SPEC.md)

## Architecture

```
protocol/
├── SPEC.md                    # Protocol specification
└── drop-metadata.schema.json  # JSON Schema

src/                           # Reference implementation (TypeScript)
├── index.ts
├── core.ts                    # createGeoDrop() factory
├── types.ts                   # All type definitions
├── verification.ts            # Pluggable verification engine
├── persistence.ts             # Persistence orchestrator (IPFS/on-chain)
├── chain.ts                   # EVM chain client
├── zkp.ts                     # Zero-knowledge proof of location (Groth16/snarkjs)
├── geofence.ts                # Haversine distance, geohash, proximity
├── crypto.ts                  # AES-GCM encryption, PBKDF2 key derivation
└── ipfs.ts                    # IPFS pinning (Pinata/web3.storage/custom)

contracts/
├── IGeoDropRegistry.sol       # Protocol interface (Solidity)
└── GeoDropRegistry.sol        # Reference implementation

circuits/
├── proximity.circom           # ZK proximity proof circuit (Groth16)
└── README.md                  # Circuit build & trusted setup instructions

database/
└── schema.sql                 # Supabase table definitions (impl-specific)

edge-functions/
└── image-proof/
    └── index.ts               # DINOv2 image verification (Supabase Edge Function)
```

## Security

- Content encrypted with AES-256-GCM; keys derived via PBKDF2 (100,000 iterations)
- Encryption key derived from `geohash + dropId + salt` — cannot decrypt without location data
- GPS spoofing detection: movement speed sanity check (300 m/s limit)
- `max_claims` enforced atomically at SQL level (TOCTOU prevention)
- Duplicate claims prevented by DB UNIQUE constraint
- AR reference embeddings stored and compared server-side (never exposed to client)
- **ZK Location Proof**: Groth16-based proximity proof — verifier learns only "within radius", never exact coordinates. Public signal validation prevents proof reuse across drops.
- Details: [`protocol/SPEC.md` §7](./protocol/SPEC.md#7-security-considerations)

## Implementing in Other Languages

GeoDrop Protocol is language-agnostic. A conforming implementation needs:

1. `DropMetadataDocument` v1 JSON format ([JSON Schema](./protocol/drop-metadata.schema.json))
2. AES-256-GCM + PBKDF2-SHA256 (100,000 iterations) encryption/decryption
3. `LocationKey = "geodrop:" + geohash + ":" + dropId + ":" + encryptionSalt` key derivation
4. `IGeoDropRegistry` Solidity interface compatibility

Any language or framework satisfying these can discover and unlock existing drops.

## License

MIT
