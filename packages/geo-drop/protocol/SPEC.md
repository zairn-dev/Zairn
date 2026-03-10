# GeoDrop Protocol Specification v1

**Status:** Draft
**Version:** 1.0.0-draft

## Abstract

GeoDrop Protocol is an open protocol for creating, discovering, and unlocking **Location-Bound Content** — digital content that can only be accessed by physically being at a specific geographic location, independent of any particular application or service.

Traditionally, location-based content (geocaching, AR experiences, location-gated NFTs, etc.) has been siloed within individual applications. This protocol solves that problem by providing a common infrastructure layer that enables any implementer to publish and consume location-bound content in an interoperable manner.

### Design Principles

1. **App-agnostic** — No dependency on any specific application, backend, or cloud service
2. **Progressive decentralization** — Operators choose their persistence level, from centralized DB to fully on-chain
3. **Physical proximity proof** — Content access requires proof of being at the location
4. **Pluggable verification** — Freely extensible beyond GPS
5. **Cryptographic locking** — Content is encrypted with a location-derived key; metadata alone is insufficient for decryption

---

## 1. Data Model

### 1.1 Drop

A Drop is the fundamental unit of the protocol — encrypted content bound to a physical location.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID v4 | Yes | Unique identifier |
| `geohash` | string (precision 7) | Yes | Location geohash |
| `lat` | float64 | Yes | Latitude |
| `lon` | float64 | Yes | Longitude |
| `unlock_radius_meters` | float32 | Yes | Unlock radius in meters |
| `title` | string | Yes | Title |
| `content_type` | ContentType | Yes | Content type |
| `ipfs_cid` | string | Yes | IPFS CID of encrypted content |
| `encrypted` | boolean | Yes | Encryption flag |
| `encryption_salt` | string | Yes | Encryption salt (hex string) |
| `visibility` | Visibility | Yes | Access scope |
| `proof_config` | ProofConfig? | No | Verification configuration |
| `max_claims` | uint? | No | Maximum number of claims |
| `expires_at` | ISO 8601? | No | Expiration timestamp |
| `created_at` | ISO 8601 | Yes | Creation timestamp |

#### ContentType enum

```
text | image | audio | video | file | nft
```

#### Visibility enum

```
public | friends | private | password
```

### 1.2 ProofConfig

Verification configuration required when accessing a drop.

```json
{
  "mode": "all" | "any",
  "requirements": [ProofRequirement, ...]
}
```

- `mode: "all"` — All required requirements must be satisfied (AND)
- `mode: "any"` — Any one required requirement is sufficient (OR)

### 1.3 ProofRequirement

```json
{
  "method": "gps" | "secret" | "ar" | "custom",
  "params": { ... },
  "required": true | false
}
```

#### Built-in Verification Methods

| method | params | submission.data | Description |
|--------|--------|----------------|-------------|
| `gps` | `{}` | `{ lat, lon, accuracy }` | GPS proximity check. Controlled by `unlock_radius_meters` |
| `secret` | `{ secret: string, label?: string }` | `{ secret: string }` | Secret value matching. Acquisition method (QR/BLE/WiFi/NFC) is unspecified |
| `ar` | `{ reference_embedding: number[], similarity_threshold?: number }` | `{ image: string }` | DINOv2 image feature vector comparison (server-side) |
| `custom` | `{ verifier_id: string, ... }` | `{ ... }` | Delegated to custom verifier |

### 1.4 ProofSubmission

Verification data submitted by the user at unlock time.

```json
{
  "method": "gps" | "secret" | "ar" | "custom",
  "data": { ... }
}
```

### 1.5 ProofResult

Verification result for each method.

```json
{
  "method": "gps" | "secret" | "ar" | "custom",
  "verified": true | false,
  "details": { ... }
}
```

---

## 2. Encryption Scheme

### 2.1 Content Encryption

| Parameter | Value |
|-----------|-------|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2-SHA256, 100,000 iterations |
| IV | 12 bytes, random |
| Salt | 16 bytes, random (for PBKDF2, generated at encryption time) |

### 2.2 Location-Based Key Derivation

The encryption password is derived via the following deterministic function:

```
LocationKey = "geodrop:" || geohash || ":" || dropId || ":" || encryptionSalt
```

- `geohash` — Drop's geohash (precision 7)
- `dropId` — UUID v4
- `encryptionSalt` — Randomly generated 16-byte hex string

This `LocationKey` is used as the PBKDF2 password, combined with a random salt generated at encryption time to derive the AES-256 key.

### 2.3 Encrypted Content Format (EncryptedPayload)

JSON structure stored on IPFS:

```json
{
  "ciphertext": "<base64>",
  "iv": "<base64>",
  "salt": "<base64>"
}
```

### 2.4 Decryption Flow

```
1. Fetch encrypted content (EncryptedPayload) from IPFS
2. Derive LocationKey: "geodrop:" + geohash + ":" + dropId + ":" + encryptionSalt
3. PBKDF2(LocationKey, payload.salt, 100000, SHA-256) → AES-256 key
4. AES-256-GCM decrypt(payload.ciphertext, key, payload.iv)
```

---

## 3. Persistence Layer

### 3.1 Metadata Document (DropMetadataDocument v1)

A self-contained metadata document that enables content recovery even after service discontinuation.

```json
{
  "version": 1,
  "dropId": "uuid-v4",
  "geohash": "xn77h3c",
  "contentCid": "Qm...",
  "encryptionSalt": "a1b2c3...",
  "unlockRadiusMeters": 50,
  "contentType": "text",
  "title": "...",
  "proofConfig": { ... } | null,
  "createdAt": "2026-03-09T00:00:00Z"
}
```

This document contains all information necessary for decryption. Pinning it to IPFS enables persistence independent of any specific database or service.

### 3.2 Encrypted Metadata

For private drops, the metadata itself can be encrypted:

```json
{
  "version": 1,
  "encrypted": true,
  "geohash": "xn77h3c",
  "payload": {
    "ciphertext": "<base64>",
    "iv": "<base64>",
    "salt": "<base64>"
  }
}
```

The `geohash` field remains in plaintext for on-chain index consistency. Decrypting the `payload` requires the `recoverySecret` set by the creator.

### 3.3 Persistence Levels

| Level | IPFS | On-chain | Cost | Durability |
|-------|------|----------|------|------------|
| `db-only` | Content only | - | Free | DB-dependent |
| `ipfs` | Content + Metadata | - | Pinning fees | Requires continued pinning |
| `onchain` | Content + Metadata | Metadata CID | Gas fees | Semi-permanent |
| `ipfs+onchain` | Content + Metadata | Metadata CID | Both | Semi-permanent |

---

## 4. On-Chain Registry

### 4.1 Interface

```solidity
interface IGeoDropRegistry {
    event DropRegistered(
        bytes7 indexed geohash,
        string metadataCid,
        address indexed sender,
        uint256 timestamp
    );

    /// @notice Register a metadata CID under a geohash (append-only)
    function registerDrop(bytes7 geohash, string calldata metadataCid) external;

    /// @notice Get all metadata CIDs for a geohash
    function getDropCids(bytes7 geohash) external view returns (string[] memory);

    /// @notice Get the number of drops registered at a geohash
    function getDropCount(bytes7 geohash) external view returns (uint256);

    /// @notice Paginated retrieval
    function getDropCidsPaginated(
        bytes7 geohash,
        uint256 offset,
        uint256 limit
    ) external view returns (string[] memory);
}
```

### 4.2 Design Rationale

- **Append-only** — Registered CIDs cannot be deleted. Drops persist as long as the chain exists
- **Permissionless** — Anyone can register. No access control
- **Minimal storage** — Only geohash (7 bytes) + CID (string). Minimizes gas costs
- **Chain-agnostic** — Deployable on any EVM-compatible chain
- **Deduplication** — `keccak256(geohash, metadataCid)` prevents duplicate registration of the same pair

### 4.3 Geohash Encoding

On-chain, geohashes are represented as `bytes7`. A 7-character ASCII geohash is left-aligned:

```
geohash "xn77h3c" → 0x786e373768336300 (bytes7)
```

### 4.4 Recommended Deployment Targets

L2 chains (Base, Polygon, Arbitrum, etc.) are recommended. Gas cost per registration is well under $0.01.

---

## 5. Discovery and Unlock Flow

### 5.1 Discovery

```
1. Obtain user's GPS coordinates (lat, lon)
2. Compute geohash (precision 5-7)
3. Enumerate center + 8 neighboring geohashes
4. Query on-chain registry for each geohash → list of metadata CIDs
5. Fetch metadata from IPFS for each CID
6. Filter by distance (unlock_radius_meters) to determine display candidates
```

### 5.2 Unlock

```
1. Collect verification data based on ProofConfig
   - GPS: coordinates + accuracy
   - Secret: value obtained via QR/BLE/WiFi/NFC etc.
   - AR: photo taken at the location
   - Custom: implementation-specific data
2. Verify all proofs (AND/OR evaluation based on mode)
3. On success → derive LocationKey
4. Fetch encrypted content from IPFS
5. Decrypt using LocationKey + EncryptedPayload
```

### 5.3 DB-Independent Recovery

Recovery flow after service discontinuation:

```
1. Physically go to the drop's location (or know the CID directly)
2. Compute geohash → query on-chain registry → obtain metadata CID
3. Fetch metadata from IPFS (decrypt with recoverySecret if encrypted)
4. Derive LocationKey from metadata: contentCid, geohash, dropId, encryptionSalt
5. Fetch content from IPFS and decrypt
```

This entire flow has zero dependency on any specific application, database, or API server.

---

## 6. Interoperability Requirements

The following requirements ensure compatibility across different implementations.

### 6.1 MUST

1. Conform to the `DropMetadataDocument` JSON structure (§3.1)
2. Use AES-256-GCM + PBKDF2-SHA256 (100,000 iterations) for encryption (§2.1)
3. Conform to the `LocationKey` derivation formula (§2.2)
4. Conform to the `EncryptedPayload` JSON structure (§2.3)
5. Conform to the `IGeoDropRegistry` Solidity interface (§4.1)
6. Use Geohash-base32 encoding
7. Conform to the `ProofConfig`, `ProofRequirement`, `ProofSubmission`, `ProofResult` schemas (§1.2-1.5)

### 6.2 SHOULD

1. Use precision-7 geohashes (7 characters ≈ 153m × 153m cell)
2. Search center + 8 neighboring geohashes during discovery
3. Account for GPS accuracy in proximity verification
4. Support built-in verification methods (gps, secret, ar)

### 6.3 MAY

1. Add custom verification methods
2. Extend `DropMetadataDocument` to `version` 2+ (maintaining backward compatibility)
3. Implement metadata encryption (§3.2)
4. Implement custom Visibility controls

---

## 7. Security Considerations

### 7.1 GPS Spoofing

GPS is easily spoofable. For high-security drops, combining supplementary verification methods (`secret`, `ar`) with `mode: "all"` is recommended.

### 7.2 Metadata Publicity

`DropMetadataDocument` contains the `encryptionSalt`. Content decryption requires `geohash + dropId + salt`, and anyone with metadata access can theoretically decrypt. This is by design — the protocol intends that "anyone who can access the location's information (≈ those physically there, or those who received the metadata CID) can access the content."

For sensitive content, use metadata encryption with `recoverySecret` (§3.2).

### 7.3 On-Chain Spam

The registry is permissionless, so arbitrary data can be registered. Client implementations should validate the `version` field of fetched metadata and ignore malformed data.

### 7.4 IPFS Pin Loss

IPFS content may disappear from the network when pins are removed. Redundant pinning across multiple services is recommended. On-chain registry CIDs are permanent, but availability of the corresponding content is not guaranteed.

---

## 8. Versioning

- Schema version is managed via the `DropMetadataDocument.version` field
- Major version changes (v2, etc.) may break backward compatibility
- Implementations must ignore unknown versions and only process supported ones
- The on-chain registry interface is immutable. Feature additions are handled by deploying new contracts

---

## Appendix

### A. Reference Implementation

TypeScript reference implementation: `@zairn/geo-drop` (this repository, `packages/geo-drop/`)

### B. Related Technologies

- [IPFS](https://ipfs.io/) — Content-addressed distributed storage
- [Geohash](https://en.wikipedia.org/wiki/Geohash) — Hierarchical spatial index
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — Browser-compatible cryptography
- [EIP-170](https://eips.ethereum.org/EIPS/eip-170) — Contract size limit (registry is well within bounds)
