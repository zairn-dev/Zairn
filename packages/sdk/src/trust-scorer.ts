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
  readonly current: Readonly<LocationPoint>;
  readonly history: readonly Readonly<LocationPoint>[];
  readonly context: {
    readonly deviceCapabilities?: Readonly<TrustDeviceCapabilities>;
    readonly recentFixes?: readonly Readonly<GpsFix>[];
    readonly networkHint?: Readonly<NetworkHint>;
    readonly imuSummary?: Readonly<ImuSummary>;
  };
  readonly baseResult: {
    readonly trustScore: number;
    readonly spoofingSuspected: boolean;
    readonly signals: Readonly<TrustScoreResult['signals']>;
  };
}

export interface TrustSignalObservation {
  /** 0 contradicts, 0.5 is neutral, and 1 corroborates the location. */
  score: number;
  reason?: string;
}

/**
 * Synchronous extension point for trusted application code.
 *
 * Providers receive precise location data in a deeply frozen snapshot. Errors
 * propagate to the caller and must be treated as a failed trust check.
 */
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
// Corroboration is weak support; contradictions retain most of their range.
const MAX_CORROBORATING_PROBABILITY = 0.54;

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
    if (!context.recentFixes.every(isValidGpsFix)) {
      return { score: 0, reason: 'invalid-raim-fix' };
    }
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
    if (!context.networkHint) return null;
    if (!isValidNetworkHint(context.networkHint)) {
      return { score: 0, reason: 'invalid-network-hint' };
    }
    return {
      score: scoreNetworkConsistency(current, context.networkHint),
      reason: 'network-distance',
    };
  },
});

function isValidNetworkHint(hint: NetworkHint): boolean {
  return (
    isValidCoordinate(hint.lat, hint.lon) &&
    Number.isFinite(hint.accuracy) &&
    hint.accuracy > 0 &&
    (hint.source === 'ip' || hint.source === 'cell' || hint.source === 'wifi')
  );
}

function isValidGpsFix(fix: Readonly<GpsFix>): boolean {
  return (
    isValidCoordinate(fix.lat, fix.lon) &&
    Number.isFinite(fix.accuracy) &&
    fix.accuracy >= 0 &&
    isValidTimestamp(fix.timestamp)
  );
}

function isValidLocationPoint(point: Readonly<LocationPoint>): boolean {
  return (
    isValidCoordinate(point.lat, point.lon) &&
    (point.accuracy === null ||
      (Number.isFinite(point.accuracy) && point.accuracy >= 0)) &&
    (point.speed === undefined || point.speed === null ||
      (Number.isFinite(point.speed) && point.speed >= 0)) &&
    isValidTimestamp(point.timestamp)
  );
}

function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

function isValidTimestamp(timestamp: string): boolean {
  return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp));
}

function invalidTrustScore(): TrustScoreResult {
  return {
    trustScore: 0,
    spoofingSuspected: true,
    signals: {
      movementPlausibility: 0,
      accuracyAnomaly: 0,
      temporalConsistency: 0,
    },
  };
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
  if (!isValidLocationPoint(current) || !history.every(isValidLocationPoint)) {
    return invalidTrustScore();
  }

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
 * V1 is used as a bounded prior and each provider contributes likelihood
 * evidence in log-odds space. Corroborating evidence is deliberately weak:
 * GNSS history and network hints can share failure modes, so consistency must
 * not erase an impossible movement or replay detected by V1. Contradictions
 * retain broad support and can move the result into step-up or deny.
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
  if (!isValidLocationPoint(current) || !history.every(isValidLocationPoint)) {
    return baseResult;
  }

  const input = createTrustSignalInput(current, history, context, baseResult);
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
  const providerSnapshots = providers.map((provider) => {
    if (typeof provider.evaluate !== 'function') {
      throw new TypeError(`Invalid evaluator for trust signal provider: ${provider.id}`);
    }
    return {
      id: provider.id,
      weight: provider.weight,
      evaluate: provider.evaluate.bind(provider),
    };
  });
  const seen = new Set<string>();
  const evidence: TrustSignalEvidence[] = [];

  for (const provider of providerSnapshots) {
    if (!provider.id || seen.has(provider.id)) {
      throw new Error(`Duplicate or empty trust signal provider id: ${provider.id}`);
    }
    if (!Number.isFinite(provider.weight) || provider.weight <= 0) {
      throw new RangeError(`Invalid weight for trust signal provider: ${provider.id}`);
    }
    seen.add(provider.id);
  }

  for (const provider of providerSnapshots) {
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

function createTrustSignalInput(
  current: LocationPoint,
  history: readonly LocationPoint[],
  context: TrustContext | undefined,
  baseResult: TrustScoreResult,
): TrustSignalInput {
  const signals = Object.freeze({ ...baseResult.signals });
  const baseResultSnapshot = Object.freeze({
    trustScore: baseResult.trustScore,
    spoofingSuspected: baseResult.spoofingSuspected,
    signals,
  });

  return Object.freeze({
    current: freezeLocationPoint(current),
    history: Object.freeze(history.map(freezeLocationPoint)),
    context: freezeTrustContext(context),
    baseResult: baseResultSnapshot,
  });
}

function freezeLocationPoint(point: Readonly<LocationPoint>): Readonly<LocationPoint> {
  return Object.freeze({
    lat: point.lat,
    lon: point.lon,
    accuracy: point.accuracy,
    timestamp: point.timestamp,
    ...(point.speed !== undefined ? { speed: point.speed } : {}),
  });
}

function freezeTrustContext(
  context: TrustContext | undefined,
): TrustSignalInput['context'] {
  const snapshot: {
    deviceCapabilities?: Readonly<TrustDeviceCapabilities>;
    recentFixes?: readonly Readonly<GpsFix>[];
    networkHint?: Readonly<NetworkHint>;
    imuSummary?: Readonly<ImuSummary>;
  } = {};

  if (context?.deviceCapabilities) {
    snapshot.deviceCapabilities = Object.freeze({ ...context.deviceCapabilities });
  }
  if (context?.recentFixes) {
    snapshot.recentFixes = Object.freeze(
      context.recentFixes.map((fix) => Object.freeze({ ...fix })),
    );
  }
  if (context?.networkHint) {
    snapshot.networkHint = Object.freeze({ ...context.networkHint });
  }
  if (context?.imuSummary) {
    snapshot.imuSummary = Object.freeze({ ...context.imuSummary });
  }

  return Object.freeze(snapshot);
}

function fuseTrustEvidence(
  baseTrustScore: number,
  evidence: readonly TrustSignalEvidence[],
): number {
  const prior = 0.1 + 0.8 * clampProbability(baseTrustScore);
  let logOdds = probabilityToLogOdds(prior);

  for (const observation of evidence) {
    const probability = calibrateEvidenceProbability(observation.score);
    logOdds += observation.weight * probabilityToLogOdds(probability);
  }

  const posterior = 1 / (1 + Math.exp(-logOdds));
  return roundProbability(Math.min(baseTrustScore, posterior));
}

function calibrateEvidenceProbability(score: number): number {
  if (score <= 0.5) {
    return PROBABILITY_EPSILON +
      (score / 0.5) * (0.5 - PROBABILITY_EPSILON);
  }
  return 0.5 +
    ((score - 0.5) / 0.5) * (MAX_CORROBORATING_PROBABILITY - 0.5);
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
  assertProbability(result.trustScore, 'trustScore');
  assertProbability(t.proceed, 'proceed threshold');
  assertProbability(t.stepUp, 'stepUp threshold');
  if (t.stepUp > t.proceed) {
    throw new RangeError('stepUp threshold must be less than or equal to proceed threshold');
  }
  if (result.trustScore >= t.proceed) return 'proceed';
  if (result.trustScore >= t.stepUp) return 'step-up';
  return 'deny';
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number between 0 and 1`);
  }
}
