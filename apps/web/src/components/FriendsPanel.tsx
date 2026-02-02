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
        className="fixed top-4 right-4 z-[1000] bg-white p-3 rounded-full shadow-lg hover:bg-gray-100"
      >
        <svg
          className="w-6 h-6 text-gray-700"
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
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {pendingRequests.length}
          </span>
        )}
      </button>

      {/* サイドパネル */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-white shadow-lg z-[1000] transform transition-transform duration-300 overflow-y-auto ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-4 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-800">友達管理</h2>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          {/* 自分のID表示 */}
          <div className="mb-4 p-3 bg-blue-50 rounded-lg">
            <p className="text-xs text-gray-600 mb-1">あなたのID（共有用）</p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-white px-2 py-1 rounded flex-1 overflow-hidden text-ellipsis text-gray-800">
                {userId}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(userId)}
                className="text-blue-600 hover:text-blue-800 text-sm"
              >
                コピー
              </button>
            </div>
          </div>

          {/* 友達申請フォーム */}
          <form onSubmit={handleSendRequest} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              友達申請を送る
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newFriendId}
                onChange={(e) => setNewFriendId(e.target.value)}
                placeholder="友達のIDを入力"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-900"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                送信
              </button>
            </div>
          </form>

          {error && (
            <div className="mb-4 text-red-600 text-sm bg-red-50 p-2 rounded">
              {error}
            </div>
          )}

          {/* 受信した友達申請 */}
          {pendingRequests.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-gray-700 mb-2">
                受信した申請 ({pendingRequests.length})
              </h3>
              <ul className="space-y-2">
                {pendingRequests.map((request) => (
                  <li
                    key={request.id}
                    className="p-2 bg-yellow-50 rounded border border-yellow-200"
                  >
                    <code className="text-xs text-gray-600 block truncate mb-2">
                      {request.from_user_id}
                    </code>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAccept(request.id)}
                        disabled={loading}
                        className="flex-1 px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                      >
                        承認
                      </button>
                      <button
                        onClick={() => handleReject(request.id)}
                        disabled={loading}
                        className="flex-1 px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
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
            <h3 className="text-sm font-medium text-gray-700 mb-2">
              友達 ({friends.length})
            </h3>
            {friends.length === 0 ? (
              <p className="text-gray-500 text-sm">まだ友達がいません</p>
            ) : (
              <ul className="space-y-2">
                {friends.map((friendId) => (
                  <li
                    key={friendId}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <code className="text-xs text-gray-600 truncate flex-1">
                      {friendId}
                    </code>
                    <button
                      onClick={() => handleRemoveFriend(friendId)}
                      disabled={loading}
                      className="text-red-600 hover:text-red-800 text-sm ml-2"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* デバッグ情報 */}
          <div className="mt-4 pt-4 border-t">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              {showDebug ? 'デバッグ情報を隠す' : 'デバッグ情報を表示'}
            </button>
            {showDebug && (
              <div className="mt-2 p-2 bg-gray-100 rounded text-xs">
                <p className="font-medium mb-1">表示可能な位置情報:</p>
                {visibleLocations.map((loc) => (
                  <div key={loc.user_id} className="mb-1 p-1 bg-white rounded">
                    <code className="block truncate">{loc.user_id}</code>
                    <span className="text-gray-500">
                      {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}
                    </span>
                    {loc.user_id === userId && (
                      <span className="ml-1 text-blue-600">(自分)</span>
                    )}
                  </div>
                ))}
                <button
                  onClick={fetchData}
                  className="mt-2 px-2 py-1 bg-gray-200 rounded hover:bg-gray-300"
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
          className="fixed inset-0 bg-black/30 z-[999]"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
