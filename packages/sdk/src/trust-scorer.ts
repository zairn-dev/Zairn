/**
 * Location Trust Scorer
 *
 * Pure functions that compute an integrity score (0.0-1.0) from a current
 * location, recent history, and optional independent position evidence.
 */

import { calculateDistance } from './core.js';

export interface LocationPoint {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: string;
  speed?: number | null;
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

export interface TrustThresholds {
  proceed: number;
  stepUp: number;
}

export interface TrustDeviceCapabilities {
  hasImu: boolean;
  hasNetworkLocation: boolean;
}

export interface GpsFix {
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: string;
}

export interface NetworkHint {
  lat: number;
  lon: number;
  accuracy: number;
  source: 'ip' | 'cell' | 'wifi';
}

export interface ImuSummary {
  stepCount: number;
  avgAccelMagnitude: number;
}

export interface TrustContext {
  deviceCapabilities?: TrustDeviceCapabilities;
  recentFixes?: GpsFix[];
  networkHint?: NetworkHint;
  imuSummary?: ImuSummary;
}

export interface TrustSignalInput {
  current: LocationPoint;
  history: readonly LocationPoint[];
  context: Readonly<TrustContext>;
  baseResult: Readonly<TrustScoreResult>;
}

export interface TrustSignalObservation {
  score: number;
  reason?: string;
}

export interface TrustSignalProvider {
  readonly id: string;
  readonly weight: number;
  evaluate(input: TrustSignalInput): TrustSignalObservation | null;
}

export interface TrustSignalEvidence extends TrustSignalObservation {
  id: string;
  weight: number;
}

export interface TrustScoreResultV2 extends TrustScoreResult {
  signals: TrustScoreResult['signals'] & {
    fixConsistency?: number;
    networkConsistency?: number;
  };
  evidence?: readonly TrustSignalEvidence[];
}

const WEIGHT_MOVEMENT = 0.5;
const WEIGHT_ACCURACY = 0.2;
const WEIGHT_TEMPORAL = 0.3;
const PROBABILITY_EPSILON = 0.01;

function scoreMovement(current: LocationPoint, history: readonly LocationPoint[]): number {
  if (history.length === 0) return 0.8;

  const prev = history[0];
  const dist = calculateDistance(prev.lat, prev.lon, current.lat, current.lon);
  const timeDiffMs =
    new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();

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

function scoreTemporalConsistency(
  current: LocationPoint,
  history: readonly LocationPoint[],
): number {
  if (history.length < 2) return 0.7;

  const points = [current, ...history.slice(0, 4)];
  let violations = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = calculateDistance(a.lat, a.lon, b.lat, b.lon);
    const dt = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (dt <= 0) {
      violations++;
      continue;
    }
    const speed = dist / (dt / 1000);
    if (speed > 100) violations++;
  }

  if (violations === 0) return 1.0;
  if (violations === 1) return 0.6;
  if (violations === 2) return 0.3;
  return 0.0;
}

function scoreFixConsistency(recentFixes: readonly GpsFix[]): number {
  const fixes = recentFixes
    .map((fix) => ({ ...fix, timeMs: new Date(fix.timestamp).getTime() }))
    .filter((fix) =>
      Number.isFinite(fix.lat) &&
      Number.isFinite(fix.lon) &&
      Number.isFinite(fix.accuracy) &&
      fix.accuracy >= 0 &&
      Number.isFinite(fix.timeMs)
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (fixes.length < 3) return 0.8;
  if (fixes[0].timeMs === fixes[fixes.length - 1].timeMs) return 0.2;

  const meanLat = fixes.reduce((sum, fix) => sum + fix.lat, 0) / fixes.length;
  const meanLon = fixes.reduce((sum, fix) => sum + fix.lon, 0) / fixes.length;
  const metersPerLonDegree = 111_320 * Math.cos(meanLat * Math.PI / 180);
  const samples = fixes.map((fix) => ({
    t: (fix.timeMs - fixes[0].timeMs) / 1000,
    x: (fix.lon - meanLon) * metersPerLonDegree,
    y: (fix.lat - meanLat) * 111_320,
  }));

  // Remove the best constant-velocity trajectory, then compare residual
  // scatter with the fixes' reported accuracy. This is a consumer-device
  // analogue of RAIM residual checking and does not punish steady movement.
  const xVariance = linearResidualVariance(samples.map(({ t, x }) => ({ t, value: x })));
  const yVariance = linearResidualVariance(samples.map(({ t, y }) => ({ t, value: y })));
  const residualRmsM = Math.sqrt(xVariance + yVariance);
  const meanAccuracyM = Math.max(
    1,
    fixes.reduce((sum, fix) => sum + fix.accuracy, 0) / fixes.length,
  );
  const ratio = residualRmsM / meanAccuracyM;

  if (ratio <= 0.5) return 1.0;
  if (ratio <= 1.0) return 1.0 - 0.3 * ((ratio - 0.5) / 0.5);
  if (ratio <= 2.0) return 0.7 - 0.3 * (ratio - 1.0);
  return 0.2;
}

function linearResidualVariance(
  samples: readonly { t: number; value: number }[],
): number {
  const meanT = samples.reduce((sum, sample) => sum + sample.t, 0) / samples.length;
  const meanValue =
    samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
  const denominator = samples.reduce(
    (sum, sample) => sum + (sample.t - meanT) ** 2,
    0,
  );
  const slope = denominator === 0
    ? 0
    : samples.reduce(
      (sum, sample) =>
        sum + (sample.t - meanT) * (sample.value - meanValue),
      0,
    ) / denominator;

  return samples.reduce((sum, sample) => {
    const predicted = meanValue + slope * (sample.t - meanT);
    return sum + (sample.value - predicted) ** 2;
  }, 0) / samples.length;
}

function scoreNetworkConsistency(current: LocationPoint, hint: NetworkHint): number {
  const dist = calculateDistance(current.lat, current.lon, hint.lat, hint.lon);
  if (dist < hint.accuracy) return 1.0;
  if (dist < 2 * hint.accuracy) return 0.7;
  if (dist < 5 * hint.accuracy) return 0.5;
  return 0.3;
}

export const temporalRaimTrustSignalProvider: TrustSignalProvider = Object.freeze({
  id: 'temporal-raim',
  weight: 1.5,
  evaluate({ context }: TrustSignalInput) {
    if (!context.recentFixes?.length) return null;
    return {
      score: scoreFixConsistency(context.recentFixes),
      reason: 'raim-residual',
    };
  },
});

export const networkCrossCheckTrustSignalProvider: TrustSignalProvider = Object.freeze({
  id: 'network-cross-check',
  weight: 2,
  evaluate({ current, context }: TrustSignalInput) {
    if (!context.networkHint || !isValidNetworkHint(context.networkHint)) return null;
    return {
      score: scoreNetworkConsistency(current, context.networkHint),
      reason: 'network-distance',
    };
  },
});

function isValidNetworkHint(hint: NetworkHint): boolean {
  return (
    Number.isFinite(hint.lat) &&
    Number.isFinite(hint.lon) &&
    Number.isFinite(hint.accuracy) &&
    hint.accuracy > 0
  );
}

export const DEFAULT_TRUST_SIGNAL_PROVIDERS: readonly TrustSignalProvider[] =
  Object.freeze([
    temporalRaimTrustSignalProvider,
    networkCrossCheckTrustSignalProvider,
  ]);

export function computeTrustScore(
  current: LocationPoint,
  history: readonly LocationPoint[],
): TrustScoreResult {
  const movementPlausibility = scoreMovement(current, history);
  const accuracyAnomaly = scoreAccuracy(current);
  const temporalConsistency = scoreTemporalConsistency(current, history);
  const raw =
    WEIGHT_MOVEMENT * movementPlausibility +
    WEIGHT_ACCURACY * accuracyAnomaly +
    WEIGHT_TEMPORAL * temporalConsistency;
  const trustScore = roundProbability(raw);

  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals: { movementPlausibility, accuracyAnomaly, temporalConsistency },
  };
}

/**
 * Compute a probabilistic integrity score with pluggable evidence providers.
 *
 * V1 is used as a bounded prior and each provider contributes independent
 * likelihood evidence in log-odds space. Bounding the prior to [0.1, 0.9]
 * prevents the heuristic V1 signals from claiming certainty, so a strong
 * independent contradiction can move the result into step-up or deny.
 *
 * With no available provider evidence, the exact V1 result is returned.
 */
export function computeTrustScoreV2(
  current: LocationPoint,
  history: readonly LocationPoint[],
  context?: TrustContext,
  providers: readonly TrustSignalProvider[] = DEFAULT_TRUST_SIGNAL_PROVIDERS,
): TrustScoreResultV2 {
  const baseResult = computeTrustScore(current, history);
  const input: TrustSignalInput = {
    current,
    history,
    context: context ?? {},
    baseResult,
  };
  const evidence = collectTrustEvidence(providers, input);
  if (evidence.length === 0) return baseResult;

  const trustScore = fuseTrustEvidence(baseResult.trustScore, evidence);
  const signals: TrustScoreResultV2['signals'] = { ...baseResult.signals };
  for (const observation of evidence) {
    if (observation.id === 'temporal-raim') {
      signals.fixConsistency = observation.score;
    } else if (observation.id === 'network-cross-check') {
      signals.networkConsistency = observation.score;
    }
  }

  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals,
    evidence,
  };
}

function collectTrustEvidence(
  providers: readonly TrustSignalProvider[],
  input: TrustSignalInput,
): TrustSignalEvidence[] {
  const seen = new Set<string>();
  const evidence: TrustSignalEvidence[] = [];

  for (const provider of providers) {
    if (!provider.id || seen.has(provider.id)) {
      throw new Error(`Duplicate or empty trust signal provider id: ${provider.id}`);
    }
    if (!Number.isFinite(provider.weight) || provider.weight <= 0) {
      throw new RangeError(`Invalid weight for trust signal provider: ${provider.id}`);
    }
    seen.add(provider.id);

    const observation = provider.evaluate(input);
    if (observation === null) continue;
    if (
      !Number.isFinite(observation.score) ||
      observation.score < 0 ||
      observation.score > 1
    ) {
      throw new RangeError(`Invalid score from trust signal provider: ${provider.id}`);
    }
    evidence.push({
      id: provider.id,
      weight: provider.weight,
      score: observation.score,
      ...(observation.reason ? { reason: observation.reason } : {}),
    });
  }

  return evidence;
}

function fuseTrustEvidence(
  baseTrustScore: number,
  evidence: readonly TrustSignalEvidence[],
): number {
  const prior = 0.1 + 0.8 * clampProbability(baseTrustScore);
  let logOdds = probabilityToLogOdds(prior);

  for (const observation of evidence) {
    logOdds += observation.weight * probabilityToLogOdds(observation.score);
  }

  return roundProbability(1 / (1 + Math.exp(-logOdds)));
}

function probabilityToLogOdds(value: number): number {
  const probability = Math.min(
    1 - PROBABILITY_EPSILON,
    Math.max(PROBABILITY_EPSILON, value),
  );
  return Math.log(probability / (1 - probability));
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundProbability(value: number): number {
  return Math.round(clampProbability(value) * 100) / 100;
}

export function gateTrustScore(
  result: TrustScoreResult,
  thresholds?: Partial<TrustThresholds>,
): 'proceed' | 'step-up' | 'deny' {
  const t: TrustThresholds = { proceed: 0.7, stepUp: 0.3, ...thresholds };
  if (result.trustScore >= t.proceed) return 'proceed';
  if (result.trustScore >= t.stepUp) return 'step-up';
  return 'deny';
}
