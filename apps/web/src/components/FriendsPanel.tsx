'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { FriendRequest, LocationCurrentRow, createLocationCore } from '@zen-map/sdk';

interface FriendsPanelProps {
  userId: string;
}

export default function FriendsPanel({ userId }: FriendsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newFriendId, setNewFriendId] = useState('');
  const [friends, setFriends] = useState<string[]>([]);
  const [pendingRequests, setPendingRequests] = useState<FriendRequest[]>([]);
  const [visibleLocations, setVisibleLocations] = useState<LocationCurrentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const core = useMemo(() => createLocationCore({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  }), []);

  // データを取得
  const fetchData = useCallback(async () => {
    try {
      const [friendList, requests, locations] = await Promise.all([
        core.getFriends(),
        core.getPendingRequests(),
        core.getVisibleFriends(),
      ]);
      setFriends(friendList);
      setPendingRequests(requests);
      setVisibleLocations(locations);
    } catch (err) {
      console.error('データ取得エラー:', err);
    }
  }, [core]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 友達申請を送信
  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFriendId.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await core.sendFriendRequest(newFriendId.trim());
      setNewFriendId('');
      alert('友達申請を送信しました');
    } catch (err) {
      setError(err instanceof Error ? err.message : '友達申請に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  // 友達申請を承認
  const handleAccept = async (requestId: number) => {
    setLoading(true);
    try {
      await core.acceptFriendRequest(requestId);
      await fetchData();
      alert('友達になりました！');
    } catch (err: any) {
      console.error('承認エラー:', err);
      alert(`承認エラー: ${err?.message || JSON.stringify(err)}`);
    } finally {
      setLoading(false);
    }
  };

  // 友達申請を拒否
  const handleReject = async (requestId: number) => {
    setLoading(true);
    try {
      await core.rejectFriendRequest(requestId);
      await fetchData();
    } catch (err) {
      console.error('拒否エラー:', err);
    } finally {
      setLoading(false);
    }
  };

  // 友達を削除
  const handleRemoveFriend = async (friendId: string) => {
    setLoading(true);
    try {
      await core.removeFriend(friendId);
      await fetchData();
    } catch (err) {
      console.error('削除エラー:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* トグルボタン */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="glass-refraction glass-tint-surface fixed top-4 right-4 z-[1000] p-3 rounded-xl"
      >
        <svg
          className="w-6 h-6 text-on-surface-variant relative z-[3]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"
          />
        </svg>
        {pendingRequests.length > 0 && (
          <span className="absolute -top-1 -right-1 bg-error text-on-error text-xs rounded-full w-5 h-5 flex items-center justify-center z-[3]">
            {pendingRequests.length}
          </span>
        )}
      </button>

      {/* サイドパネル */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-surface-container-lowest shadow-lg z-[1000] transform transition-transform duration-300 overflow-y-auto ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-4 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-on-surface">友達管理</h2>
            <button
              onClick={() => setIsOpen(false)}
              className="text-on-surface-variant hover:text-on-surface"
            >
              ✕
            </button>
          </div>

          {/* 自分のID表示 */}
          <div className="mb-4 p-3 bg-primary-container rounded-lg">
            <p className="text-xs text-on-primary-container/70 mb-1">あなたのID（共有用）</p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-surface-container-lowest px-2 py-1 rounded flex-1 overflow-hidden text-ellipsis text-on-surface">
                {userId}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(userId)}
                className="text-primary hover:brightness-90 text-sm"
              >
                コピー
              </button>
            </div>
          </div>

          {/* 友達申請フォーム */}
          <form onSubmit={handleSendRequest} className="mb-4">
            <label className="block text-sm font-medium text-on-surface-variant mb-1">
              友達申請を送る
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newFriendId}
                onChange={(e) => setNewFriendId(e.target.value)}
                placeholder="友達のIDを入力"
                className="flex-1 px-3 py-2 border border-outline-variant rounded-md text-sm text-on-surface bg-surface-container-lowest"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-primary text-on-primary rounded-md hover:brightness-90 disabled:opacity-50 text-sm"
              >
                送信
              </button>
            </div>
          </form>

          {error && (
            <div className="mb-4 text-error text-sm bg-error-container p-2 rounded">
              {error}
            </div>
          )}

          {/* 受信した友達申請 */}
          {pendingRequests.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-on-surface-variant mb-2">
                受信した申請 ({pendingRequests.length})
              </h3>
              <ul className="space-y-2">
                {pendingRequests.map((request) => (
                  <li
                    key={request.id}
                    className="p-2 bg-tertiary-container rounded border border-outline-variant"
                  >
                    <code className="text-xs text-on-tertiary-container block truncate mb-2">
                      {request.from_user_id}
                    </code>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAccept(request.id)}
                        disabled={loading}
                        className="flex-1 px-2 py-1 bg-primary text-on-primary text-xs rounded hover:brightness-90"
                      >
                        承認
                      </button>
                      <button
                        onClick={() => handleReject(request.id)}
                        disabled={loading}
                        className="flex-1 px-2 py-1 bg-error text-on-error text-xs rounded hover:brightness-90"
                      >
                        拒否
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 友達リスト */}
          <div className="mb-4">
            <h3 className="text-sm font-medium text-on-surface-variant mb-2">
              友達 ({friends.length})
            </h3>
            {friends.length === 0 ? (
              <p className="text-outline text-sm">まだ友達がいません</p>
            ) : (
              <ul className="space-y-2">
                {friends.map((friendId) => (
                  <li
                    key={friendId}
                    className="flex items-center justify-between p-2 bg-surface-container rounded"
                  >
                    <code className="text-xs text-on-surface-variant truncate flex-1">
                      {friendId}
                    </code>
                    <button
                      onClick={() => handleRemoveFriend(friendId)}
                      disabled={loading}
                      className="text-error hover:brightness-90 text-sm ml-2"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* デバッグ情報 */}
          <div className="mt-4 pt-4 border-t border-outline-variant">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="text-xs text-outline hover:text-on-surface-variant"
            >
              {showDebug ? 'デバッグ情報を隠す' : 'デバッグ情報を表示'}
            </button>
            {showDebug && (
              <div className="mt-2 p-2 bg-surface-container rounded text-xs">
                <p className="font-medium mb-1">表示可能な位置情報:</p>
                {visibleLocations.map((loc) => (
                  <div key={loc.user_id} className="mb-1 p-1 bg-surface-container-lowest rounded">
                    <code className="block truncate">{loc.user_id}</code>
                    <span className="text-outline">
                      {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}
                    </span>
                    {loc.user_id === userId && (
                      <span className="ml-1 text-primary">(自分)</span>
                    )}
                  </div>
                ))}
                <button
                  onClick={fetchData}
                  className="mt-2 px-2 py-1 bg-surface-container-high rounded hover:bg-surface-container-highest"
                >
                  更新
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* オーバーレイ */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-scrim/30 z-[999]"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
