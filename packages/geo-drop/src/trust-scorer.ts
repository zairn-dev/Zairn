/**
 * GeoDrop trust scoring facade.
 *
 * The SDK owns the integrity model and provider implementations. GeoDrop keeps
 * this facade for API compatibility and adds session latch semantics for
 * location-bound actions.
 */

import {
  computeTrustScore as computeSdkTrustScore,
  computeTrustScoreV2 as computeSdkTrustScoreV2,
  gateTrustScore as gateSdkTrustScore,
  temporalRaimTrustSignalProvider,
  networkCrossCheckTrustSignalProvider,
  DEFAULT_TRUST_SIGNAL_PROVIDERS,
} from '@zairn/sdk';
import type {
  TrustSignalEvidence,
  TrustSignalInput,
  TrustSignalObservation,
  TrustSignalProvider,
} from '@zairn/sdk';
import type {
  LocationPoint,
  TrustContext,
  TrustScoreResult,
  TrustScoreResultV2,
  TrustThresholds,
} from './types.js';

export {
  temporalRaimTrustSignalProvider,
  networkCrossCheckTrustSignalProvider,
  DEFAULT_TRUST_SIGNAL_PROVIDERS,
};
export type {
  TrustSignalEvidence,
  TrustSignalInput,
  TrustSignalObservation,
  TrustSignalProvider,
};

export function computeTrustScore(
  current: LocationPoint,
  history: readonly LocationPoint[],
): TrustScoreResult {
  return computeSdkTrustScore(current, history);
}

export function computeTrustScoreV2(
  current: LocationPoint,
  history: readonly LocationPoint[],
  context?: TrustContext,
  providers: readonly TrustSignalProvider[] = DEFAULT_TRUST_SIGNAL_PROVIDERS,
): TrustScoreResultV2 {
  return computeSdkTrustScoreV2(current, history, context, providers);
}

export function gateTrustScore(
  result: TrustScoreResult,
  thresholds?: Partial<TrustThresholds>,
): 'proceed' | 'step-up' | 'deny' {
  return gateSdkTrustScore(result, thresholds);
}

/**
 * Session-aware trust gate with latch semantics.
 *
 * Once the gate transitions to 'step-up' or 'deny', all later fixes in the
 * session retain that state until reset. This prevents a spoofer from
 * triggering one anomaly and then settling at a spoofed location.
 */
export interface TrustSession {
  gate(
    result: TrustScoreResult,
    thresholds?: Partial<TrustThresholds>,
  ): 'proceed' | 'step-up' | 'deny';
  readonly latched: boolean;
  readonly latchedState: 'step-up' | 'deny' | null;
  readonly fixCount: number;
  reset(): void;
}

export function createTrustSession(): TrustSession {
  let latchedState: 'step-up' | 'deny' | null = null;
  let fixCount = 0;

  return {
    gate(result, thresholds) {
      fixCount++;
      if (latchedState !== null) return latchedState;
      const decision = gateTrustScore(result, thresholds);
      if (decision !== 'proceed') latchedState = decision;
      return decision;
    },
    get latched() {
      return latchedState !== null;
    },
    get latchedState() {
      return latchedState;
    },
    get fixCount() {
      return fixCount;
    },
    reset() {
      latchedState = null;
      fixCount = 0;
    },
  };
}
