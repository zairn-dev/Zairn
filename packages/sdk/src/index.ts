/**
 * @zen-map/sdk
 * 位置情報共有アプリケーション用SDK
 */

// 型定義のエクスポート
export * from './types';

// コア機能のエクスポート
export { createLocationCore, calculateDistance, estimateMotionType } from './core';
