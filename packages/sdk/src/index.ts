/**
 * @zairn/sdk
 * 位置情報共有アプリケーション用SDK
 */

// 型定義のエクスポート
export * from './types';

// コア機能のエクスポート
export { createLocationCore, calculateDistance, estimateMotionType, encodeGeohash, decodeGeohash } from './core';

// ポリシーエンジン（高度な利用向け）
export { evaluatePolicies, coarsenLocation } from './policy-engine';
export type { EvaluationContext } from './policy-engine';

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
  DEFAULT_PRIVACY_CONFIG,
} from './privacy-location';
export type {
  SensitivePlace,
  PrivacyZoneRule,
  LocationState,
  PrivacyConfig,
} from './privacy-location';
