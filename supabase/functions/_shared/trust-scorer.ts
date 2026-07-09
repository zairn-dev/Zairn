/**
 * Location Trust Scorer (Edge Function copy)
 *
 * Server-side port of packages/geo-drop/src/trust-scorer.ts's V1 scoring
 * (computeTrustScore + gateTrustScore only — no V2 RAIM/network context,
 * which unlock-drop doesn't have inputs for). Kept in sync manually, same
 * pattern as this function's existing duplicated crypto helpers — Deno
 * edge functions can't import from the npm workspace package directly.
 *
 * Used to close the gap where trust/velocity scoring only ran in the
 * client-side dev-only unlock path (core.ts) and never in production
 * (this Edge Function), meaning spoofing/velocity checks were entirely
 * unenforced in production. See docs/IMPROVEMENT-ROADMAP.md #7.
 */

export interface LocationPoint {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: string;
}

export interface TrustScoreResult {
  trustScore: number;
  spoofingSuspected: boolean;
  signals: {
    movementPlausibility: number;
    accuracyAnomaly: number;
    temporalConsistency: number;
  };
}

const WEIGHT_MOVEMENT = 0.5;
const WEIGHT_ACCURACY = 0.2;
const WEIGHT_TEMPORAL = 0.3;

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreMovement(current: LocationPoint, history: LocationPoint[]): number {
  if (history.length === 0) return 0.8;
  const prev = history[0];
  const dist = calculateDistance(prev.lat, prev.lon, current.lat, current.lon);
  const timeDiffMs = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();
  if (timeDiffMs <= 0) return 0.0;
  const speedMs = dist / (timeDiffMs / 1000);
  if (speedMs <= 50) return 1.0;
  if (speedMs <= 150) return 1.0 - 0.5 * ((speedMs - 50) / 100);
  if (speedMs <= 300) return 0.5 - 0.4 * ((speedMs - 150) / 150);
  return 0.0;
}

function scoreAccuracy(current: LocationPoint): number {
  const acc = current.accuracy;
  if (acc === null || acc === undefined) return 0.5;
  if (acc < 2) return 0.3;
  if (acc <= 100) return 1.0;
  if (acc <= 500) return 0.7;
  return 0.4;
}

function scoreTemporalConsistency(current: LocationPoint, history: LocationPoint[]): number {
  if (history.length < 2) return 0.7;
  const points = [current, ...history.slice(0, 4)];
  let violations = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = calculateDistance(a.lat, a.lon, b.lat, b.lon);
    const dt = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (dt <= 0) { violations++; continue; }
    const speed = dist / (dt / 1000);
    if (speed > 100) violations++;
  }
  if (violations === 0) return 1.0;
  if (violations === 1) return 0.6;
  if (violations === 2) return 0.3;
  return 0.0;
}

export function computeTrustScore(current: LocationPoint, history: LocationPoint[]): TrustScoreResult {
  const movementPlausibility = scoreMovement(current, history);
  const accuracyAnomaly = scoreAccuracy(current);
  const temporalConsistency = scoreTemporalConsistency(current, history);
  const raw =
    WEIGHT_MOVEMENT * movementPlausibility +
    WEIGHT_ACCURACY * accuracyAnomaly +
    WEIGHT_TEMPORAL * temporalConsistency;
  const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals: { movementPlausibility, accuracyAnomaly, temporalConsistency },
  };
}

export function gateTrustScore(
  result: TrustScoreResult,
  thresholds?: { proceed?: number; stepUp?: number },
): 'proceed' | 'step-up' | 'deny' {
  const proceed = thresholds?.proceed ?? 0.7;
  const stepUp = thresholds?.stepUp ?? 0.3;
  if (result.trustScore >= proceed) return 'proceed';
  if (result.trustScore >= stepUp) return 'step-up';
  return 'deny';
}
