'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { Polyline } from 'react-leaflet';
import { LocationHistoryRow, createLocationCore } from '@zen-map/sdk';

const TIME_BUCKETS = [
  { maxHoursAgo: 1, opacity: 0.9, weight: 4 },
  { maxHoursAgo: 4, opacity: 0.6, weight: 3 },
  { maxHoursAgo: 12, opacity: 0.4, weight: 2 },
  { maxHoursAgo: 24, opacity: 0.2, weight: 2 },
];

const TRAIL_COLORS = [
  '#6442d6', // primary — 自分
  '#625b71', // secondary — フレンド1
  '#7d5260', // tertiary — フレンド2
  '#006c4c', // green — フレンド3
  '#8b5000', // amber — フレンド4
  '#00658e', // cyan — フレンド5
];

interface TrailSegment {
  positions: [number, number][];
  opacity: number;
  weight: number;
  color: string;
}

interface TrailLayerProps {
  userId: string;
  visible: boolean;
  demo?: boolean;
  center?: { lat: number; lon: number } | null;
}

function segmentByTimeBucket(
  points: LocationHistoryRow[],
  color: string
): TrailSegment[] {
  const now = Date.now();
  const bucketPoints = new Map<number, [number, number][]>();

  const chronological = [...points].reverse();

  for (const point of chronological) {
    const hoursAgo = (now - new Date(point.recorded_at).getTime()) / 3600000;
    let bucketIdx = TIME_BUCKETS.findIndex(b => hoursAgo <= b.maxHoursAgo);
    if (bucketIdx === -1) bucketIdx = TIME_BUCKETS.length - 1;

    if (!bucketPoints.has(bucketIdx)) bucketPoints.set(bucketIdx, []);
    bucketPoints.get(bucketIdx)!.push([point.lat, point.lon]);
  }

  // バケット間の接続: 前のバケットの最後のポイントを次のバケットの先頭に追加
  const sortedBuckets = [...bucketPoints.entries()].sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < sortedBuckets.length - 1; i++) {
    const currentPositions = sortedBuckets[i][1];
    const nextPositions = sortedBuckets[i + 1][1];
    if (currentPositions.length > 0 && nextPositions.length > 0) {
      nextPositions.unshift(currentPositions[currentPositions.length - 1]);
    }
  }

  const segments: TrailSegment[] = [];
  for (const [idx, positions] of bucketPoints.entries()) {
    if (positions.length >= 2) {
      segments.push({
        positions,
        opacity: TIME_BUCKETS[idx].opacity,
        weight: TIME_BUCKETS[idx].weight,
        color,
      });
    }
  }

  return segments;
}

// =====================
// デモデータ生成
// =====================

// シード付き疑似乱数（再レンダーで安定）
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateDemoTrail(
  centerLat: number,
  centerLon: number,
  seed: number,
  totalPoints: number,
  hoursSpan: number,
): LocationHistoryRow[] {
  const rng = seededRandom(seed);
  const points: LocationHistoryRow[] = [];
  const now = Date.now();

  // 緯度経度1度あたり約111km → 30m ≈ 0.00027度
  const stepDeg = 0.00027;

  let lat = centerLat + (rng() - 0.5) * 0.005;
  let lon = centerLon + (rng() - 0.5) * 0.005;
  let heading = rng() * Math.PI * 2;

  for (let i = 0; i < totalPoints; i++) {
    const hoursAgo = hoursSpan * (1 - i / totalPoints);
    const timestamp = new Date(now - hoursAgo * 3600000).toISOString();

    points.push({
      id: seed * 10000 + i,
      user_id: `demo-${seed}`,
      lat,
      lon,
      accuracy: 10 + rng() * 20,
      recorded_at: timestamp,
    });

    // ランダムウォーク（方向はゆるやかに変化）
    heading += (rng() - 0.5) * 1.2;

    // ときどき停滞（10%の確率）
    if (rng() > 0.1) {
      const speed = 0.5 + rng() * 1.5; // 歩行速度のばらつき
      lat += Math.cos(heading) * stepDeg * speed;
      lon += Math.sin(heading) * stepDeg * speed / Math.cos(lat * Math.PI / 180);
    }

    // 中心から離れすぎたら引き戻す
    const distFromCenter = Math.sqrt(
      Math.pow(lat - centerLat, 2) + Math.pow(lon - centerLon, 2)
    );
    if (distFromCenter > 0.015) {
      heading = Math.atan2(centerLon - lon, centerLat - lat) + (rng() - 0.5) * 0.5;
    }
  }

  return points;
}

function generateDemoSegments(
  centerLat: number,
  centerLon: number,
): TrailSegment[] {
  const allSegments: TrailSegment[] = [];

  // 自分の軌跡（24時間、300ポイント）
  const myTrail = generateDemoTrail(centerLat, centerLon, 42, 300, 24);
  allSegments.push(...segmentByTimeBucket(myTrail, TRAIL_COLORS[0]));

  // フレンド1（18時間、200ポイント）
  const friend1Trail = generateDemoTrail(centerLat, centerLon, 137, 200, 18);
  allSegments.push(...segmentByTimeBucket(friend1Trail, TRAIL_COLORS[1]));

  // フレンド2（12時間、150ポイント）
  const friend2Trail = generateDemoTrail(centerLat, centerLon, 256, 150, 12);
  allSegments.push(...segmentByTimeBucket(friend2Trail, TRAIL_COLORS[2]));

  return allSegments;
}

// =====================
// コンポーネント
// =====================

export default function TrailLayer({ userId, visible, demo, center }: TrailLayerProps) {
  const [segments, setSegments] = useState<TrailSegment[]>([]);

  const core = useMemo(() => createLocationCore({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  }), []);

  // デモデータの生成
  useEffect(() => {
    if (!visible || !demo) return;

    const lat = center?.lat ?? 35.6812;
    const lon = center?.lon ?? 139.7671;
    setSegments(generateDemoSegments(lat, lon));
  }, [visible, demo, center]);

  // 実データの取得
  const fetchTrails = useCallback(async () => {
    if (!visible || demo) return;

    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const allSegments: TrailSegment[] = [];

      const myHistory = await core.getLocationHistory(userId, { limit: 500, since });
      allSegments.push(...segmentByTimeBucket(myHistory, TRAIL_COLORS[0]));

      const friendIds = await core.getTrailFriendIds();
      const friendHistories = await Promise.all(
        friendIds.slice(0, 10).map(id =>
          core.getLocationHistory(id, { limit: 200, since })
            .then(history => ({ id, history }))
            .catch(() => ({ id, history: [] as LocationHistoryRow[] }))
        )
      );

      for (let i = 0; i < friendHistories.length; i++) {
        const { history } = friendHistories[i];
        if (history.length > 0) {
          const color = TRAIL_COLORS[(i + 1) % TRAIL_COLORS.length];
          allSegments.push(...segmentByTimeBucket(history, color));
        }
      }

      setSegments(allSegments);
    } catch (err) {
      console.error('軌跡取得エラー:', err);
    }
  }, [core, userId, visible, demo]);

  useEffect(() => {
    if (demo) return;
    fetchTrails();
    const interval = setInterval(fetchTrails, 60000);
    return () => clearInterval(interval);
  }, [fetchTrails, demo]);

  if (!visible || segments.length === 0) return null;

  return (
    <>
      {segments.map((seg, i) => (
        <Polyline
          key={`trail-${i}-${seg.color}-${seg.opacity}`}
          positions={seg.positions}
          pathOptions={{
            color: seg.color,
            opacity: seg.opacity,
            weight: seg.weight,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
    </>
  );
}
