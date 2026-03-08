'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { BumpEvent, NearbyUser, createLocationCore } from '@zen-map/sdk';

interface BumpPanelProps {
  userId: string;
  currentLocation: { lat: number; lon: number } | null;
  onClose: () => void;
}

export default function BumpPanel({ userId, currentLocation, onClose }: BumpPanelProps) {
  const [nearbyFriends, setNearbyFriends] = useState<NearbyUser[]>([]);
  const [bumpHistory, setBumpHistory] = useState<BumpEvent[]>([]);
  const [searching, setSearching] = useState(false);
  const [radius, setRadius] = useState(500);

  const core = useMemo(() => createLocationCore({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  }), []);

  // 近くの友達を検索
  const searchNearby = useCallback(async () => {
    if (!currentLocation) return;

    setSearching(true);
    try {
      const nearby = await core.findNearbyFriends(
        currentLocation.lat,
        currentLocation.lon,
        radius
      );
      setNearbyFriends(nearby);
    } catch (err) {
      console.error('検索エラー:', err);
    } finally {
      setSearching(false);
    }
  }, [core, currentLocation, radius]);

  // Bump履歴を取得
  const fetchHistory = useCallback(async () => {
    try {
      const history = await core.getBumpHistory({ limit: 20 });
      setBumpHistory(history);
    } catch (err) {
      console.error('履歴取得エラー:', err);
    }
  }, [core]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Bump記録
  const handleBump = async (nearbyUser: NearbyUser) => {
    if (!currentLocation) return;

    try {
      await core.recordBump(
        nearbyUser.user_id,
        nearbyUser.distance_meters,
        currentLocation.lat,
        currentLocation.lon
      );
      await fetchHistory();
      alert(`${nearbyUser.user_id.slice(0, 8)}... とBumpしました!`);
    } catch (err) {
      console.error('Bump記録エラー:', err);
    }
  };

  // 時間の相対表示
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    return `${diffDay}日前`;
  };

  return (
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-scrim/50">
      <div className="bg-surface-container-lowest rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b border-outline-variant">
          <h2 className="text-lg font-bold text-on-surface">Bump</h2>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface text-xl"
          >
            ✕
          </button>
        </div>

        {/* 検索セクション */}
        <div className="p-4 border-b border-outline-variant bg-secondary-container">
          <p className="text-sm text-on-secondary-container mb-3">
            近くにいる友達を見つけて、すれ違いを記録しよう
          </p>

          {/* 範囲選択 */}
          <div className="flex items-center gap-2 mb-3">
            <label className="text-sm text-on-secondary-container/70">範囲:</label>
            <select
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              className="px-3 py-1 border border-outline-variant rounded text-on-surface bg-surface-container-lowest"
            >
              <option value={100}>100m</option>
              <option value={250}>250m</option>
              <option value={500}>500m</option>
              <option value={1000}>1km</option>
            </select>
          </div>

          {!currentLocation ? (
            <p className="text-sm text-error">位置情報が取得できていません</p>
          ) : (
            <button
              onClick={searchNearby}
              disabled={searching}
              className="w-full py-2 bg-secondary text-on-secondary rounded-lg hover:brightness-90 disabled:opacity-50"
            >
              {searching ? '検索中...' : '近くの友達を検索'}
            </button>
          )}
        </div>

        {/* 近くの友達 */}
        {nearbyFriends.length > 0 && (
          <div className="p-4 border-b border-outline-variant">
            <h3 className="text-sm font-medium text-on-surface-variant mb-2">
              近くにいる友達 ({nearbyFriends.length}人)
            </h3>
            <ul className="space-y-2">
              {nearbyFriends.map(friend => (
                <li
                  key={friend.user_id}
                  className="flex items-center justify-between p-3 bg-secondary-container rounded-lg"
                >
                  <div>
                    <p className="text-sm font-medium text-on-surface">
                      {friend.user_id.slice(0, 8)}...
                    </p>
                    <p className="text-xs text-secondary">
                      {friend.distance_meters}m 先
                    </p>
                  </div>
                  <button
                    onClick={() => handleBump(friend)}
                    className="px-4 py-1 bg-secondary text-on-secondary text-sm rounded-full hover:brightness-90"
                  >
                    Bump!
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Bump履歴 */}
        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="text-sm font-medium text-on-surface-variant mb-2">Bump履歴</h3>
          {bumpHistory.length === 0 ? (
            <p className="text-outline text-sm">まだBump履歴がありません</p>
          ) : (
            <ul className="space-y-2">
              {bumpHistory.map(bump => {
                const isMe = bump.user_id === userId;
                const otherId = isMe ? bump.nearby_user_id : bump.user_id;

                return (
                  <li
                    key={bump.id}
                    className="flex items-center gap-3 p-3 bg-surface-container rounded-lg"
                  >
                    <div className="w-10 h-10 bg-secondary-container rounded-full flex items-center justify-center">
                      <span className="text-secondary text-lg">
                        {isMe ? '👋' : '🤝'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-on-surface">
                        {isMe ? 'あなた' : `${otherId.slice(0, 8)}...`}
                        <span className="text-outline"> と </span>
                        {isMe ? `${otherId.slice(0, 8)}...` : 'あなた'}
                      </p>
                      <p className="text-xs text-outline">
                        {bump.distance_meters}m • {formatTime(bump.created_at)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
