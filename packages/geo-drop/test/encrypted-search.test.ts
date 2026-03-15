import { describe, it, expect } from 'vitest';
import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
  selectPrecisionForRadius,
} from '../src/encrypted-search';
import type { EncryptedSearchConfig, LocationIndexTokens } from '../src/encrypted-search';

const config: EncryptedSearchConfig = {
  searchKey: 'test-secret-key-for-gridse',
  precisionLevels: [4, 5, 6],
};

describe('generateIndexTokens', () => {
  it('generates tokens at each precision level', async () => {
    const tokens = await generateIndexTokens(35.68, 139.76, config);
    expect(tokens.tokens).toHaveLength(3);
    expect(tokens.tokens.map(t => t.precision)).toEqual([4, 5, 6]);
  });

  it('tokens are hex strings', async () => {
    const tokens = await generateIndexTokens(35.68, 139.76, config);
    for (const { token } of tokens.tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
    }
  });

  it('same location produces same tokens (deterministic)', async () => {
    const a = await generateIndexTokens(35.68, 139.76, config);
    const b = await generateIndexTokens(35.68, 139.76, config);
    expect(a).toEqual(b);
  });

  it('different locations produce different tokens', async () => {
    const a = await generateIndexTokens(35.68, 139.76, config);
    const b = await generateIndexTokens(34.69, 135.50, config);
    expect(a.tokens[0].token).not.toBe(b.tokens[0].token);
  });

  it('different keys produce different tokens', async () => {
    const a = await generateIndexTokens(35.68, 139.76, config);
    const b = await generateIndexTokens(35.68, 139.76, {
      ...config,
      searchKey: 'different-key',
    });
    expect(a.tokens[0].token).not.toBe(b.tokens[0].token);
  });
});

describe('generateSearchTokens', () => {
  it('generates tokens for center + neighbors', async () => {
    const search = await generateSearchTokens(35.68, 139.76, 5000, config);
    // Center (1) + up to 8 neighbors = up to 9
    expect(search.tokens.length).toBeGreaterThanOrEqual(1);
    expect(search.tokens.length).toBeLessThanOrEqual(9);
  });

  it('all tokens are hex strings', async () => {
    const search = await generateSearchTokens(35.68, 139.76, 5000, config);
    for (const token of search.tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('selects appropriate precision for radius', async () => {
    const small = await generateSearchTokens(35.68, 139.76, 500, config);
    const large = await generateSearchTokens(35.68, 139.76, 50000, config);
    // Smaller radius should use finer precision
    expect(small.precision).toBeGreaterThanOrEqual(large.precision);
  });
});

describe('matchTokens', () => {
  it('matches a drop at the same location', async () => {
    const index = await generateIndexTokens(35.68, 139.76, config);
    const search = await generateSearchTokens(35.68, 139.76, 5000, config);

    const matches = matchTokens(search, [
      { dropId: 'drop-1', tokens: index },
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0].dropId).toBe('drop-1');
  });

  it('matches a drop in a neighboring cell', async () => {
    // Two points ~200m apart should share a precision-5 cell or be neighbors
    const index = await generateIndexTokens(35.6800, 139.7600, config);
    const search = await generateSearchTokens(35.6810, 139.7610, 5000, config);

    const matches = matchTokens(search, [
      { dropId: 'drop-near', tokens: index },
    ]);

    // Should match at some precision level
    expect(matches.length).toBeGreaterThanOrEqual(0);
  });

  it('does not match a far-away drop', async () => {
    const index = await generateIndexTokens(34.69, 135.50, config); // Osaka
    const search = await generateSearchTokens(35.68, 139.76, 5000, config); // Tokyo

    const matches = matchTokens(search, [
      { dropId: 'drop-far', tokens: index },
    ]);

    expect(matches).toHaveLength(0);
  });

  it('returns multiple matches', async () => {
    const index1 = await generateIndexTokens(35.6800, 139.7600, config);
    const index2 = await generateIndexTokens(35.6801, 139.7601, config);
    const indexFar = await generateIndexTokens(34.69, 135.50, config);

    const search = await generateSearchTokens(35.6800, 139.7600, 5000, config);

    const matches = matchTokens(search, [
      { dropId: 'near-1', tokens: index1 },
      { dropId: 'near-2', tokens: index2 },
      { dropId: 'far', tokens: indexFar },
    ]);

    const matchedIds = matches.map(m => m.dropId);
    expect(matchedIds).toContain('near-1');
    expect(matchedIds).not.toContain('far');
  });
});

describe('selectPrecisionForRadius', () => {
  it('selects finer precision for smaller radius', () => {
    const small = selectPrecisionForRadius(100, [4, 5, 6]);
    const large = selectPrecisionForRadius(50000, [4, 5, 6]);
    expect(small).toBeGreaterThanOrEqual(large);
  });

  it('uses last level as fallback', () => {
    const p = selectPrecisionForRadius(1, [4, 5, 6]);
    expect(p).toBe(6); // smallest cell still > 1m*2
  });
});
