import { describe, it, expect } from 'vitest';
import {
  toFixedPoint,
  metersToRadiusSquared,
  cosLatScaled,
  validatePublicSignals,
  buildZkStatementBinding,
  validateRegionPublicSignals,
  MAX_POLYGON_VERTICES,
} from '../src/zkp';

describe('toFixedPoint', () => {
  it('converts 0 to 0n', () => {
    expect(toFixedPoint(0)).toBe(0n);
  });

  it('converts positive degrees', () => {
    expect(toFixedPoint(35.68)).toBe(35_680_000n);
  });

  it('converts negative degrees', () => {
    expect(toFixedPoint(-33.87)).toBe(-33_870_000n);
  });

  it('handles high precision', () => {
    // 0.000001° ≈ 0.11m → 1 unit
    expect(toFixedPoint(0.000001)).toBe(1n);
  });
});

describe('metersToRadiusSquared', () => {
  it('converts 100m radius', () => {
    const rs = metersToRadiusSquared(100);
    // 100m / 111320 ≈ 0.000898° → ×1e6 ≈ 898 → 898² ≈ 806404
    expect(rs).toBeGreaterThan(800_000n);
    expect(rs).toBeLessThan(820_000n);
  });

  it('returns 0 for 0m radius', () => {
    expect(metersToRadiusSquared(0)).toBe(0n);
  });

  it('scales quadratically', () => {
    const r100 = metersToRadiusSquared(100);
    const r200 = metersToRadiusSquared(200);
    // 200m radius squared should be ~4x 100m radius squared
    const ratio = Number(r200) / Number(r100);
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.2);
  });
});

describe('cosLatScaled', () => {
  it('returns ~1e6 at equator', () => {
    const cos0 = cosLatScaled(0);
    expect(cos0).toBe(1_000_000n);
  });

  it('returns ~707107 at 45°', () => {
    const cos45 = cosLatScaled(45);
    expect(Number(cos45)).toBeGreaterThan(706_000);
    expect(Number(cos45)).toBeLessThan(708_000);
  });

  it('returns ~0 at poles', () => {
    const cos90 = cosLatScaled(90);
    expect(Number(cos90)).toBeLessThan(100); // approximately 0
  });

  it('is symmetric for ±lat', () => {
    expect(cosLatScaled(35)).toBe(cosLatScaled(-35));
  });
});

describe('validatePublicSignals (proximity)', () => {
  const targetLat = 35.68;
  const targetLon = 139.76;
  const radius = 100;

  function makeValidSignals(): string[] {
    return [
      '1', // valid
      toFixedPoint(targetLat).toString(),
      toFixedPoint(targetLon).toString(),
      metersToRadiusSquared(radius).toString(),
      cosLatScaled(targetLat).toString(),
    ];
  }

  it('accepts valid signals', () => {
    expect(validatePublicSignals(makeValidSignals(), targetLat, targetLon, radius)).toBe(true);
  });

  it('rejects if valid flag is 0', () => {
    const signals = makeValidSignals();
    signals[0] = '0';
    expect(validatePublicSignals(signals, targetLat, targetLon, radius)).toBe(false);
  });

  it('rejects mismatched target lat', () => {
    expect(validatePublicSignals(makeValidSignals(), 35.69, targetLon, radius)).toBe(false);
  });

  it('rejects mismatched target lon', () => {
    expect(validatePublicSignals(makeValidSignals(), targetLat, 139.77, radius)).toBe(false);
  });

  it('rejects mismatched radius', () => {
    expect(validatePublicSignals(makeValidSignals(), targetLat, targetLon, 200)).toBe(false);
  });

  it('rejects too few signals', () => {
    expect(validatePublicSignals(['1', '2'], targetLat, targetLon, radius)).toBe(false);
  });
});

describe('buildZkStatementBinding', () => {
  it('produces deterministic output for same input', async () => {
    const context = { dropId: 'drop-1', epoch: 100, serverNonce: 'nonce-abc' };
    const a = await buildZkStatementBinding(context);
    const b = await buildZkStatementBinding(context);
    expect(a.contextDigest).toBe(b.contextDigest);
    expect(a.epoch).toBe(b.epoch);
    expect(a.challengeDigest).toBe(b.challengeDigest);
  });

  it('epoch is stringified', async () => {
    const result = await buildZkStatementBinding({
      dropId: 'drop-1', epoch: 42, serverNonce: 'nonce',
    });
    expect(result.epoch).toBe('42');
  });

  it('different drop IDs produce different context digests', async () => {
    const a = await buildZkStatementBinding({ dropId: 'drop-1', epoch: 1, serverNonce: 'n' });
    const b = await buildZkStatementBinding({ dropId: 'drop-2', epoch: 1, serverNonce: 'n' });
    expect(a.contextDigest).not.toBe(b.contextDigest);
  });

  it('different nonces produce different challenge digests', async () => {
    const a = await buildZkStatementBinding({ dropId: 'drop-1', epoch: 1, serverNonce: 'nonce-a' });
    const b = await buildZkStatementBinding({ dropId: 'drop-1', epoch: 1, serverNonce: 'nonce-b' });
    expect(a.challengeDigest).not.toBe(b.challengeDigest);
  });
});

describe('validateRegionPublicSignals', () => {
  const polygon = [
    { lat: 35.68, lon: 139.75 },
    { lat: 35.69, lon: 139.76 },
    { lat: 35.68, lon: 139.77 },
  ];

  function makeValidRegionSignals(): string[] {
    const LAT_SHIFT = 90_000_000n;
    const LON_SHIFT = 180_000_000n;

    const signals: string[] = ['1']; // valid

    // polyLat[0..15]
    for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
      if (i < polygon.length) {
        signals.push((toFixedPoint(polygon[i].lat) + LAT_SHIFT).toString());
      } else {
        signals.push('0');
      }
    }

    // polyLon[0..15]
    for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
      if (i < polygon.length) {
        signals.push((toFixedPoint(polygon[i].lon) + LON_SHIFT).toString());
      } else {
        signals.push('0');
      }
    }

    // vertexCount
    signals.push(polygon.length.toString());

    return signals;
  }

  it('accepts valid region signals', () => {
    expect(validateRegionPublicSignals(makeValidRegionSignals(), polygon)).toBe(true);
  });

  it('rejects if valid flag is 0', () => {
    const signals = makeValidRegionSignals();
    signals[0] = '0';
    expect(validateRegionPublicSignals(signals, polygon)).toBe(false);
  });

  it('rejects mismatched polygon', () => {
    const differentPolygon = [
      { lat: 36.00, lon: 140.00 },
      { lat: 36.01, lon: 140.01 },
      { lat: 36.00, lon: 140.02 },
    ];
    expect(validateRegionPublicSignals(makeValidRegionSignals(), differentPolygon)).toBe(false);
  });

  it('rejects too few signals', () => {
    expect(validateRegionPublicSignals(['1'], polygon)).toBe(false);
  });
});
