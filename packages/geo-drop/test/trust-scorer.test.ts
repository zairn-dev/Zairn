import { describe, it, expect } from 'vitest';
import { computeTrustScore, computeTrustScoreV2, gateTrustScore } from '../src/trust-scorer';
import type { LocationPoint, TrustScoreResult, TrustScoreResultV2, StepUpRequired, UnlockSuccess, UnlockResult, GpsFix, NetworkHint, TrustContext } from '../src/types';

function makePoint(lat: number, lon: number, minutesAgo: number, accuracy: number | null = 10): LocationPoint {
  return {
    lat,
    lon,
    accuracy,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

describe('computeTrustScore', () => {
  it('returns high score for normal movement', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [
      makePoint(35.6801, 139.7601, 1), // ~14m in 1 min = 0.23 m/s (walking)
    ];
    const result = computeTrustScore(current, history);
    expect(result.trustScore).toBeGreaterThanOrEqual(0.7);
    expect(result.spoofingSuspected).toBe(false);
  });

  it('returns moderate score with no history', () => {
    const current = makePoint(35.68, 139.76, 0);
    const result = computeTrustScore(current, []);
    // No history: movement=0.8, accuracy depends on value, temporal=0.7
    expect(result.trustScore).toBeGreaterThan(0.5);
    expect(result.trustScore).toBeLessThan(1.0);
  });

  it('returns low score for teleportation', () => {
    const current = makePoint(34.69, 135.50, 0, null); // Osaka, null accuracy
    const history = [
      makePoint(35.68, 139.76, 1), // Tokyo → teleport
      makePoint(34.69, 135.50, 2), // Osaka → teleport
      makePoint(35.68, 139.76, 3), // Tokyo → teleport
      makePoint(34.69, 135.50, 4), // Osaka → teleport
    ];
    const result = computeTrustScore(current, history);
    expect(result.trustScore).toBeLessThan(0.3);
    expect(result.spoofingSuspected).toBe(true);
    expect(result.signals.movementPlausibility).toBe(0);
    expect(result.signals.temporalConsistency).toBe(0);
  });

  it('flags suspiciously precise accuracy (<2m)', () => {
    const current = makePoint(35.68, 139.76, 0, 0.5);
    const history = [makePoint(35.68, 139.76, 1)];
    const result = computeTrustScore(current, history);
    expect(result.signals.accuracyAnomaly).toBe(0.3);
  });

  it('gives full accuracy score for normal GPS (2-100m)', () => {
    const current = makePoint(35.68, 139.76, 0, 15);
    const history = [makePoint(35.68, 139.76, 1)];
    const result = computeTrustScore(current, history);
    expect(result.signals.accuracyAnomaly).toBe(1.0);
  });

  it('penalizes null accuracy', () => {
    const current = makePoint(35.68, 139.76, 0, null);
    const history = [makePoint(35.68, 139.76, 1)];
    const result = computeTrustScore(current, history);
    expect(result.signals.accuracyAnomaly).toBe(0.5);
  });

  it('detects temporal violations in history', () => {
    const current = makePoint(35.68, 139.76, 0);
    const history = [
      makePoint(34.69, 135.50, 1),  // teleportation
      makePoint(35.68, 139.76, 2),  // back again
      makePoint(34.69, 135.50, 3),  // teleportation again
    ];
    const result = computeTrustScore(current, history);
    expect(result.signals.temporalConsistency).toBeLessThan(0.5);
  });

  it('clamps score to [0, 1]', () => {
    const current = makePoint(35.68, 139.76, 0);
    const result = computeTrustScore(current, []);
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
    expect(result.trustScore).toBeLessThanOrEqual(1);
  });
});

describe('gateTrustScore', () => {
  it('returns proceed for high score', () => {
    const result: TrustScoreResult = {
      trustScore: 0.9,
      spoofingSuspected: false,
      signals: { movementPlausibility: 1, accuracyAnomaly: 1, temporalConsistency: 1 },
    };
    expect(gateTrustScore(result)).toBe('proceed');
  });

  it('returns step-up for medium score', () => {
    const result: TrustScoreResult = {
      trustScore: 0.5,
      spoofingSuspected: false,
      signals: { movementPlausibility: 0.5, accuracyAnomaly: 0.5, temporalConsistency: 0.5 },
    };
    expect(gateTrustScore(result)).toBe('step-up');
  });

  it('returns deny for low score', () => {
    const result: TrustScoreResult = {
      trustScore: 0.1,
      spoofingSuspected: true,
      signals: { movementPlausibility: 0, accuracyAnomaly: 0.3, temporalConsistency: 0 },
    };
    expect(gateTrustScore(result)).toBe('deny');
  });

  it('respects custom thresholds', () => {
    const result: TrustScoreResult = {
      trustScore: 0.6,
      spoofingSuspected: false,
      signals: { movementPlausibility: 0.6, accuracyAnomaly: 0.6, temporalConsistency: 0.6 },
    };
    expect(gateTrustScore(result, { proceed: 0.5 })).toBe('proceed');
    expect(gateTrustScore(result, { proceed: 0.8 })).toBe('step-up');
  });

  it('handles boundary values', () => {
    const make = (score: number): TrustScoreResult => ({
      trustScore: score,
      spoofingSuspected: score < 0.3,
      signals: { movementPlausibility: score, accuracyAnomaly: score, temporalConsistency: score },
    });
    expect(gateTrustScore(make(0.7))).toBe('proceed');
    expect(gateTrustScore(make(0.3))).toBe('step-up');
    expect(gateTrustScore(make(0.29))).toBe('deny');
  });
});

describe('StepUpRequired / UnlockResult types', () => {
  it('StepUpRequired has correct shape', () => {
    const stepUp: StepUpRequired = {
      type: 'step-up-required',
      trustScore: 0.45,
      reason: 'GPS signal unstable',
      availableMethods: ['secret', 'ar'],
      dropId: 'test-drop-id',
    };
    expect(stepUp.type).toBe('step-up-required');
    expect(stepUp.availableMethods).toContain('secret');
    expect(stepUp.trustScore).toBe(0.45);
  });

  it('UnlockSuccess has correct shape', () => {
    const success: UnlockSuccess = {
      type: 'success',
      content: 'decrypted content',
      claim: {} as any,
      verification: { verified: true, proofs: [], timestamp: new Date().toISOString() },
    };
    expect(success.type).toBe('success');
    expect(success.content).toBe('decrypted content');
  });

  it('UnlockResult discriminates by type field', () => {
    const results: UnlockResult[] = [
      {
        type: 'step-up-required',
        trustScore: 0.5,
        reason: 'test',
        availableMethods: ['secret'],
        dropId: 'drop-1',
      },
      {
        type: 'success',
        content: 'hello',
        claim: {} as any,
        verification: { verified: true, proofs: [], timestamp: '' },
      },
    ];

    for (const r of results) {
      if (r.type === 'step-up-required') {
        expect(r.availableMethods.length).toBeGreaterThan(0);
        expect(r.dropId).toBeTruthy();
      } else {
        expect(r.content).toBe('hello');
      }
    }
  });
});

// =====================
// Trust Scorer V2 tests
// =====================

function makeFix(lat: number, lon: number, accuracy: number, minutesAgo: number): GpsFix {
  return { lat, lon, accuracy, timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString() };
}

describe('computeTrustScoreV2', () => {
  // --- Fix consistency tests ---

  it('gives high fix consistency for stable GPS fixes', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const fixes: GpsFix[] = [
      makeFix(35.68000, 139.76000, 10, 0),
      makeFix(35.68001, 139.76001, 10, 0.5),
      makeFix(35.67999, 139.75999, 10, 1),
      makeFix(35.68002, 139.76002, 10, 1.5),
    ];
    const result = computeTrustScoreV2(current, history, { recentFixes: fixes });
    expect(result.signals.fixConsistency).toBeDefined();
    expect(result.signals.fixConsistency!).toBeGreaterThanOrEqual(0.9);
  });

  it('gives low fix consistency for scattered fixes', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    // Scatter: fixes jump ~500m apart but report 10m accuracy
    const fixes: GpsFix[] = [
      makeFix(35.6800, 139.7600, 10, 0),
      makeFix(35.6850, 139.7650, 10, 0.5),
      makeFix(35.6750, 139.7550, 10, 1),
      makeFix(35.6900, 139.7700, 10, 1.5),
    ];
    const result = computeTrustScoreV2(current, history, { recentFixes: fixes });
    expect(result.signals.fixConsistency).toBeDefined();
    expect(result.signals.fixConsistency!).toBeLessThanOrEqual(0.4);
  });

  it('returns 0.8 fix consistency for insufficient fixes (<3)', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const fixes: GpsFix[] = [
      makeFix(35.6800, 139.7600, 10, 0),
      makeFix(35.6801, 139.7601, 10, 0.5),
    ];
    const result = computeTrustScoreV2(current, history, { recentFixes: fixes });
    expect(result.signals.fixConsistency).toBe(0.8);
  });

  // --- Network consistency tests ---

  it('gives high network score when GPS matches network hint', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const hint: NetworkHint = { lat: 35.6801, lon: 139.7601, accuracy: 500, source: 'wifi' };
    const result = computeTrustScoreV2(current, history, { networkHint: hint });
    expect(result.signals.networkConsistency).toBe(1.0);
  });

  it('gives 0.7 network score when within 2x accuracy', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    // ~1.5km away, accuracy=1000m → within 2x
    const hint: NetworkHint = { lat: 35.6900, lon: 139.7700, accuracy: 1000, source: 'cell' };
    const result = computeTrustScoreV2(current, history, { networkHint: hint });
    expect(result.signals.networkConsistency).toBe(0.7);
  });

  it('gives 0.3 network score when far from hint', () => {
    const current = makePoint(35.6800, 139.7600, 0); // Tokyo
    const history = [makePoint(35.6801, 139.7601, 1)];
    // Osaka hint, accuracy=1000m → way beyond 5x
    const hint: NetworkHint = { lat: 34.6900, lon: 135.5000, accuracy: 1000, source: 'ip' };
    const result = computeTrustScoreV2(current, history, { networkHint: hint });
    expect(result.signals.networkConsistency).toBe(0.3);
  });

  // --- Delegation to V1 ---

  it('returns identical result to V1 when context is undefined', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const v1 = computeTrustScore(current, history);
    const v2 = computeTrustScoreV2(current, history);
    expect(v2.trustScore).toBe(v1.trustScore);
    expect(v2.signals.movementPlausibility).toBe(v1.signals.movementPlausibility);
    expect(v2.signals.accuracyAnomaly).toBe(v1.signals.accuracyAnomaly);
    expect(v2.signals.temporalConsistency).toBe(v1.signals.temporalConsistency);
  });

  it('returns identical result to V1 when context is empty', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const v1 = computeTrustScore(current, history);
    const v2 = computeTrustScoreV2(current, history, {});
    expect(v2.trustScore).toBe(v1.trustScore);
  });

  // --- Combined tests ---

  it('gives high score for honest user with all signals', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const context: TrustContext = {
      recentFixes: [
        makeFix(35.68000, 139.76000, 10, 0),
        makeFix(35.68001, 139.76001, 10, 0.5),
        makeFix(35.67999, 139.75999, 10, 1),
      ],
      networkHint: { lat: 35.6801, lon: 139.7601, accuracy: 500, source: 'wifi' },
    };
    const result = computeTrustScoreV2(current, history, context);
    expect(result.trustScore).toBeGreaterThanOrEqual(0.7);
    expect(result.spoofingSuspected).toBe(false);
    expect(result.signals.fixConsistency).toBeDefined();
    expect(result.signals.networkConsistency).toBeDefined();
  });

  it('detects spoofer with all signals low', () => {
    // Teleportation + scattered fixes + network mismatch
    const current = makePoint(34.69, 135.50, 0, 0.5); // Osaka, suspiciously precise
    const history = [
      makePoint(35.68, 139.76, 1), // Tokyo
      makePoint(34.69, 135.50, 2),
      makePoint(35.68, 139.76, 3),
    ];
    const context: TrustContext = {
      recentFixes: [
        makeFix(35.68, 139.76, 5, 0),
        makeFix(34.69, 135.50, 5, 0.5),
        makeFix(35.68, 139.76, 5, 1),
      ],
      networkHint: { lat: 40.71, lon: -74.00, accuracy: 5000, source: 'ip' }, // New York
    };
    const result = computeTrustScoreV2(current, history, context);
    expect(result.trustScore).toBeLessThan(0.3);
    expect(result.spoofingSuspected).toBe(true);
  });

  it('detects VPN spoofer: normal GPS but network mismatch', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const context: TrustContext = {
      networkHint: { lat: 37.7749, lon: -122.4194, accuracy: 5000, source: 'ip' }, // San Francisco
    };
    const result = computeTrustScoreV2(current, history, context);
    expect(result.signals.networkConsistency).toBe(0.3);
    // Movement and temporal fine, but network drags it down
    expect(result.trustScore).toBeLessThan(0.9);
  });

  it('is compatible with gateTrustScore', () => {
    const current = makePoint(35.6800, 139.7600, 0);
    const history = [makePoint(35.6801, 139.7601, 1)];
    const context: TrustContext = {
      recentFixes: [
        makeFix(35.68000, 139.76000, 10, 0),
        makeFix(35.68001, 139.76001, 10, 0.5),
        makeFix(35.67999, 139.75999, 10, 1),
      ],
    };
    const result = computeTrustScoreV2(current, history, context);
    const gate = gateTrustScore(result);
    expect(['proceed', 'step-up', 'deny']).toContain(gate);
  });
});
