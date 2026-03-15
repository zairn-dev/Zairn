/**
 * GridSE-inspired Encrypted Geographic Search
 *
 * Enables geographic proximity queries over encrypted data so the backend
 * cannot learn drop locations or search patterns.
 *
 * Approach (simplified GridSE):
 * 1. Drop creator generates HMAC-based index tokens from geohash prefixes
 *    at multiple precision levels. Tokens are stored alongside the drop.
 * 2. Searcher generates search tokens from their location + radius,
 *    covering the target geohash cell and its neighbors.
 * 3. Backend performs set intersection on opaque tokens — it never sees
 *    coordinates, only learns "these tokens matched" (which reveals only
 *    the approximate area, not the exact point).
 * 4. Client receives candidate drops and filters locally with exact distance.
 *
 * Security properties:
 * - Backend sees only HMAC tokens (deterministic but key-dependent)
 * - Same location produces the same token set → enables search
 * - Without the key, tokens are indistinguishable from random
 * - Geohash precision controls the privacy/utility tradeoff
 *
 * References:
 * - GridSE: Towards Practical Secure Geographic Search, USENIX Security 2024
 */

import { encodeGeohash, geohashNeighbors } from './geofence';

// =====================
// Types
// =====================

/** Configuration for encrypted search */
export interface EncryptedSearchConfig {
  /**
   * Shared secret key for HMAC token generation.
   * Must be identical for indexing and searching.
   * In production, derive from a group key or user-specific secret.
   */
  searchKey: string;
  /**
   * Geohash precision levels to index.
   * Lower precision = coarser area = more matches but less privacy.
   * Default: [4, 5, 6] (≈40km, ≈5km, ≈1.2km cells)
   */
  precisionLevels?: number[];
}

/** A set of index tokens for a single location */
export interface LocationIndexTokens {
  /** HMAC tokens keyed by precision level */
  tokens: { precision: number; token: string }[];
}

/** A set of search tokens for a proximity query */
export interface SearchTokenSet {
  /** Tokens to match against (includes neighbors) */
  tokens: string[];
  /** Precision level used for this search */
  precision: number;
}

/** Result of an encrypted search match */
export interface EncryptedSearchMatch {
  /** Drop ID that matched */
  dropId: string;
  /** Which precision level matched */
  matchedPrecision: number;
}

// =====================
// Constants
// =====================

const DEFAULT_PRECISION_LEVELS = [4, 5, 6];

/** Approximate cell diameter in meters per geohash precision */
const PRECISION_TO_METERS: Record<number, number> = {
  1: 5000_000,
  2: 1250_000,
  3: 156_000,
  4: 39_000,
  5: 4_900,
  6: 1_200,
  7: 150,
  8: 38,
};

// =====================
// HMAC token generation (Web Crypto API)
// =====================

/**
 * Import a string key for HMAC-SHA256
 */
async function importHmacKey(keyStr: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Compute HMAC-SHA256 and return as hex string
 */
async function hmacToken(key: CryptoKey, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

// =====================
// Public API
// =====================

/**
 * Generate index tokens for a location.
 * Called during drop creation; tokens are stored in the DB.
 *
 * @param lat - Drop latitude
 * @param lon - Drop longitude
 * @param config - Encrypted search configuration
 * @returns Index tokens at each precision level
 */
export async function generateIndexTokens(
  lat: number,
  lon: number,
  config: EncryptedSearchConfig,
): Promise<LocationIndexTokens> {
  const levels = config.precisionLevels ?? DEFAULT_PRECISION_LEVELS;
  const key = await importHmacKey(config.searchKey);

  const tokens: { precision: number; token: string }[] = [];

  for (const precision of levels) {
    const geohash = encodeGeohash(lat, lon, precision);
    const token = await hmacToken(key, `gridse:index:${precision}:${geohash}`);
    tokens.push({ precision, token });
  }

  return { tokens };
}

/**
 * Generate search tokens for a proximity query.
 * The token set includes the target cell and all neighbors at the
 * appropriate precision level for the given radius.
 *
 * @param lat - Search center latitude
 * @param lon - Search center longitude
 * @param radiusMeters - Search radius in meters
 * @param config - Encrypted search configuration
 * @returns Search tokens to send to the backend
 */
export async function generateSearchTokens(
  lat: number,
  lon: number,
  radiusMeters: number,
  config: EncryptedSearchConfig,
): Promise<SearchTokenSet> {
  const levels = config.precisionLevels ?? DEFAULT_PRECISION_LEVELS;
  const key = await importHmacKey(config.searchKey);

  // Select precision level: use the coarsest level whose cell size
  // is smaller than 2x the search radius (ensures neighbors cover the area)
  let selectedPrecision = levels[levels.length - 1];
  for (const p of levels) {
    const cellSize = PRECISION_TO_METERS[p] ?? 150;
    if (cellSize <= radiusMeters * 2) {
      selectedPrecision = p;
      break;
    }
  }

  const centerGeohash = encodeGeohash(lat, lon, selectedPrecision);
  const neighbors = geohashNeighbors(centerGeohash);
  const allCells = [centerGeohash, ...neighbors];

  const tokens: string[] = [];
  for (const cell of allCells) {
    const token = await hmacToken(
      key,
      `gridse:index:${selectedPrecision}:${cell}`,
    );
    tokens.push(token);
  }

  return { tokens, precision: selectedPrecision };
}

/**
 * Server-side token matching (runs on backend / Edge Function).
 * Given a set of search tokens and a list of indexed drops,
 * returns drops whose index tokens intersect with the search tokens.
 *
 * This function sees only opaque hex strings — no coordinates.
 *
 * @param searchTokens - Tokens from generateSearchTokens
 * @param indexedDrops - Array of { dropId, tokens } from DB
 * @returns Matching drop IDs with precision info
 */
export function matchTokens(
  searchTokens: SearchTokenSet,
  indexedDrops: { dropId: string; tokens: LocationIndexTokens }[],
): EncryptedSearchMatch[] {
  const searchSet = new Set(searchTokens.tokens);
  const matches: EncryptedSearchMatch[] = [];

  for (const drop of indexedDrops) {
    for (const { precision, token } of drop.tokens.tokens) {
      if (precision === searchTokens.precision && searchSet.has(token)) {
        matches.push({
          dropId: drop.dropId,
          matchedPrecision: precision,
        });
        break; // one match per drop is sufficient
      }
    }
  }

  return matches;
}

/**
 * Select the best precision level for a given search radius.
 * Exported for use in query planning.
 */
export function selectPrecisionForRadius(
  radiusMeters: number,
  levels: number[] = DEFAULT_PRECISION_LEVELS,
): number {
  let selected = levels[levels.length - 1];
  for (const p of levels) {
    const cellSize = PRECISION_TO_METERS[p] ?? 150;
    if (cellSize <= radiusMeters * 2) {
      selected = p;
      break;
    }
  }
  return selected;
}
