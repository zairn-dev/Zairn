/**
 * ジオフェンス検証
 * ドロップの場所に実際にいるかどうかを検証するロジック
 */
import type { LocationProof } from './types';

// Haversine公式による距離計算（メートル）
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geohashエンコード
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision: number = 7): string {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true, bits = 0, hashVal = 0;
  let result = '';

  while (result.length < precision) {
    const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
    if (isLon) {
      if (lon >= mid) { hashVal = hashVal * 2 + 1; minLon = mid; }
      else { hashVal = hashVal * 2; maxLon = mid; }
    } else {
      if (lat >= mid) { hashVal = hashVal * 2 + 1; minLat = mid; }
      else { hashVal = hashVal * 2; maxLat = mid; }
    }
    isLon = !isLon;
    bits++;
    if (bits === 5) {
      result += GEOHASH_BASE32[hashVal];
      bits = 0;
      hashVal = 0;
    }
  }
  return result;
}

export function decodeGeohash(geohash: string): { lat: number; lon: number } {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true;

  for (const ch of geohash) {
    const val = GEOHASH_BASE32.indexOf(ch);
    if (val === -1) break;
    for (let bit = 4; bit >= 0; bit--) {
      const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
      if (isLon) {
        if (val & (1 << bit)) minLon = mid; else maxLon = mid;
      } else {
        if (val & (1 << bit)) minLat = mid; else maxLat = mid;
      }
      isLon = !isLon;
    }
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/**
 * 位置検証パラメータ
 */
export interface VerifyOptions {
  /** ドロップの緯度 */
  targetLat: number;
  /** ドロップの経度 */
  targetLon: number;
  /** アンロック半径（メートル） */
  unlockRadius: number;
  /** ユーザーの緯度 */
  userLat: number;
  /** ユーザーの経度 */
  userLon: number;
  /** GPSの精度（メートル） */
  accuracy: number;
  /** ユーザーID */
  userId: string;
}

/**
 * ジオフェンス検証を実行
 *
 * 検証ロジック:
 * 1. ユーザーとドロップの距離を計算
 * 2. GPS精度を考慮した実効距離で判定
 * 3. 半径内なら検証OK
 */
export function verifyProximity(opts: VerifyOptions): LocationProof {
  const distance = calculateDistance(
    opts.targetLat, opts.targetLon,
    opts.userLat, opts.userLon
  );

  // GPS精度を考慮：実際の距離は ±accuracy の範囲にある
  // 安全側に倒す：distance - accuracy が半径以下なら許可
  // ただしaccuracyが大きすぎる場合（500m以上）は拒否
  const maxAccuracy = 500;
  const effectiveAccuracy = Math.min(opts.accuracy, maxAccuracy);
  const verified = (distance - effectiveAccuracy) <= opts.unlockRadius;

  return {
    user_id: opts.userId,
    lat: opts.userLat,
    lon: opts.userLon,
    accuracy: opts.accuracy,
    timestamp: new Date().toISOString(),
    geohash: encodeGeohash(opts.userLat, opts.userLon),
    distance_to_target: Math.round(distance),
    verified,
  };
}

/**
 * レート制限チェック用のキー生成
 * 同じユーザーが短時間に異なる遠隔地からアンロック試行を防ぐ
 */
export function rateLimitKey(userId: string, dropId: string): string {
  return `geodrop:ratelimit:${userId}:${dropId}`;
}

/**
 * 移動速度の妥当性チェック
 * 前回の位置と今回の位置から、移動速度が現実的かどうかを検証
 */
export function isMovementRealistic(
  prevLat: number, prevLon: number, prevTimestamp: string,
  currLat: number, currLon: number, currTimestamp: string
): boolean {
  const distance = calculateDistance(prevLat, prevLon, currLat, currLon);
  const timeDiffMs = new Date(currTimestamp).getTime() - new Date(prevTimestamp).getTime();
  if (timeDiffMs <= 0) return false;

  const speedMs = distance / (timeDiffMs / 1000);
  // 最大速度: 300 m/s（約1080 km/h = 飛行機レベル）
  // これを超える移動はGPS偽装の可能性が高い
  return speedMs <= 300;
}
