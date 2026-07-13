import { describe, expect, it } from 'vitest';
import {
  computeTrustScore,
  computeTrustScoreV2,
  gateTrustScore,
} from '../src/trust-scorer';
import type {
  GpsFix,
  LocationPoint,
  NetworkHint,
  TrustSignalProvider,
} from '../src/trust-scorer';

const NOW = Date.UTC(2026, 0, 1);

function point(
  lat: number,
  lon: number,
  minutesAgo: number,
  accuracy: number | null = 10,
): LocationPoint {
  return {
    lat,
    lon,
    accuracy,
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
  };
}

function fix(
  lat: number,
  lon: number,
  minutesAgo: number,
  accuracy = 10,
): GpsFix {
  return {
    lat,
    lon,
    accuracy,
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
  };
}

const current = point(35.68, 139.76, 0);
const normalHistory = [
  point(35.6801, 139.7601, 1),
  point(35.6802, 139.7602, 2),
];

describe('computeTrustScore V1 compatibility', () => {
  it('keeps normal movement above the proceed threshold', () => {
    const result = computeTrustScore(current, normalHistory);

    expect(result.trustScore).toBeGreaterThanOrEqual(0.7);
    expect(gateTrustScore(result)).toBe('proceed');
  });

  it('returns the exact V1 shape when V2 has no provider evidence', () => {
    const v1 = computeTrustScore(current, normalHistory);

    expect(computeTrustScoreV2(current, normalHistory)).toEqual(v1);
    expect(computeTrustScoreV2(current, normalHistory, {})).toEqual(v1);
  });
});

describe('computeTrustScoreV2 default providers', () => {
  it('keeps a constant-velocity fix sequence RAIM-consistent', () => {
    const recentFixes = [
      fix(35.6800, 139.7600, 3),
      fix(35.6801, 139.7601, 2),
      fix(35.6802, 139.7602, 1),
      fix(35.6803, 139.7603, 0),
    ];

    const result = computeTrustScoreV2(current, normalHistory, { recentFixes });

    expect(result.signals.fixConsistency).toBeGreaterThanOrEqual(0.9);
    expect(result.evidence?.[0]).toMatchObject({
      id: 'temporal-raim',
      reason: 'raim-residual',
    });
  });

  it('detects fixes that do not fit a plausible trajectory', () => {
    const recentFixes = [
      fix(35.6800, 139.7600, 3),
      fix(35.6900, 139.7700, 2),
      fix(35.6750, 139.7550, 1),
      fix(35.7000, 139.7800, 0),
    ];

    const result = computeTrustScoreV2(current, normalHistory, { recentFixes });

    expect(result.signals.fixConsistency).toBeLessThanOrEqual(0.4);
    expect(gateTrustScore(result)).toBe('step-up');
  });

  it('uses an insufficient-data score for fewer than three fixes', () => {
    const result = computeTrustScoreV2(current, normalHistory, {
      recentFixes: [
        fix(35.68, 139.76, 1),
        fix(35.6801, 139.7601, 0),
      ],
    });

    expect(result.signals.fixConsistency).toBe(0.8);
  });

  it('steps up when a normal GNSS trace conflicts with network location', () => {
    const matching: NetworkHint = {
      lat: 35.6801,
      lon: 139.7601,
      accuracy: 500,
      source: 'wifi',
    };
    const conflicting: NetworkHint = {
      lat: 34.69,
      lon: 135.5,
      accuracy: 1000,
      source: 'ip',
    };

    const match = computeTrustScoreV2(current, normalHistory, {
      networkHint: matching,
    });
    const conflict = computeTrustScoreV2(current, normalHistory, {
      networkHint: conflicting,
    });

    expect(match.signals.networkConsistency).toBe(1);
    expect(conflict.signals.networkConsistency).toBe(0.3);
    expect(conflict.trustScore).toBeLessThan(match.trustScore);
    expect(gateTrustScore(conflict)).toBe('step-up');
  });

  it('ignores malformed network hints instead of treating them as evidence', () => {
    const v1 = computeTrustScore(current, normalHistory);
    const v2 = computeTrustScoreV2(current, normalHistory, {
      networkHint: {
        lat: 35.68,
        lon: 139.76,
        accuracy: 0,
        source: 'cell',
      },
    });

    expect(v2).toEqual(v1);
  });

  it('denies a combined teleportation, RAIM, and network mismatch', () => {
    const spoofedHistory = [
      point(34.69, 135.5, 1),
      point(34.6901, 135.5001, 2),
    ];
    const result = computeTrustScoreV2(current, spoofedHistory, {
      recentFixes: [
        fix(35.68, 139.76, 3),
        fix(35.70, 139.78, 2),
        fix(35.66, 139.74, 1),
        fix(35.72, 139.80, 0),
      ],
      networkHint: {
        lat: 34.69,
        lon: 135.5,
        accuracy: 1000,
        source: 'ip',
      },
    });

    expect(result.trustScore).toBeLessThan(0.3);
    expect(result.spoofingSuspected).toBe(true);
    expect(gateTrustScore(result)).toBe('deny');
  });
});

describe('TrustSignalProvider', () => {
  it('accepts custom independent evidence providers', () => {
    const provider: TrustSignalProvider = {
      id: 'test-attestation',
      weight: 2,
      evaluate: () => ({ score: 0.05, reason: 'attestation-failed' }),
    };

    const result = computeTrustScoreV2(
      current,
      normalHistory,
      undefined,
      [provider],
    );

    expect(result.evidence).toEqual([{
      id: 'test-attestation',
      weight: 2,
      score: 0.05,
      reason: 'attestation-failed',
    }]);
    expect(gateTrustScore(result)).toBe('deny');
  });

  it('rejects duplicate provider ids', () => {
    const provider: TrustSignalProvider = {
      id: 'duplicate',
      weight: 1,
      evaluate: () => null,
    };

    expect(() => computeTrustScoreV2(
      current,
      normalHistory,
      undefined,
      [provider, provider],
    )).toThrow('Duplicate or empty trust signal provider id');
  });

  it('rejects out-of-range provider scores', () => {
    const provider: TrustSignalProvider = {
      id: 'invalid',
      weight: 1,
      evaluate: () => ({ score: 2 }),
    };

    expect(() => computeTrustScoreV2(
      current,
      normalHistory,
      undefined,
      [provider],
    )).toThrow('Invalid score from trust signal provider');
  });
});
