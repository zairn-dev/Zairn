import { describe, it, expect } from 'vitest';
import { computeTrustScore, gateTrustScore } from '../src/trust-scorer';
import type { LocationPoint, TrustScoreResult, StepUpRequired, UnlockSuccess, UnlockResult } from '../src/types';

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
