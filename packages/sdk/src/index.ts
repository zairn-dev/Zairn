/**
 * @zairn/sdk
 * 位置情報共有アプリケーション用SDK
 */

// 型定義のエクスポート
export * from './types.js';

// コア機能のエクスポート
export { createLocationCore, calculateDistance, estimateMotionType, encodeGeohash, decodeGeohash } from './core.js';

// ポリシーエンジン（高度な利用向け）
export { evaluatePolicies, coarsenLocation } from './policy-engine.js';
export type { EvaluationContext } from './policy-engine.js';

// Privacy-preserving location sharing
export {
  createPrivacyProcessor,
  validatePrivacyConfig,
  detectSensitivePlaces,
  obfuscateLocation,
  addPlanarLaplaceNoise,
  gridSnap,
  bucketizeDistance,
  processLocation,
  FrequencyBudget,
  AdaptiveReporter,
  FixedRateReporter,
  jitterDepartureTime,
  createSensingGate,
  createSensingGateController,
  runSensingCycle,
  DEFAULT_GATE_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
} from './privacy-location.js';
export type {
  SensitivePlace,
  PrivacyZoneRule,
  SensingGateConfig,
  SensingGateMotion,
  SensingGateLastFix,
  SensingGateInput,
  GateDecision,
  SensingGate,
  SensingGateControllerInput,
  SensingGateControllerState,
  SensingGateController,
  SensingAcquirer,
  SensingCycleResult,
  LocationState,
  PrivacyConfig,
} from './privacy-location.js';
