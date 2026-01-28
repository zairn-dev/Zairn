'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { createClient, LocationReaction } from '@/lib/supabase';
import { createLocationCore } from '@/lib/location-core';

interface ReactionPanelProps {
  userId: string;
  selectedFriendId?: string | null;
  onClose: () => void;
}

const EMOJI_OPTIONS = ['👋', '❤️', '😊', '🎉', '🔥', '👍', '😂', '🤔'];

export default function ReactionPanel({ userId, selectedFriendId, onClose }: ReactionPanelProps) {
  const [receivedReactions, setReceivedReactions] = useState<LocationReaction[]>([]);
  const [selectedEmoji, setSelectedEmoji] = useState<string>('👋');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const supabase = useMemo(() => createClient(), []);
  const core = useMemo(() => createLocationCore(supabase), [supabase]);

  // 受信リアクションを取得
  const fetchReactions = useCallback(async () => {
    try {
      const reactions = await core.getReceivedReactions({ limit: 20 });
      setReceivedReactions(reactions);
    } catch (err) {
      console.error('リアクション取得エラー:', err);
    }
  }, [core]);

  useEffect(() => {
    fetchReactions();

    // Realtimeで新着リアクションを購読
    const channel = core.subscribeReactions((reaction) => {
      if (reaction.to_user_id === userId) {
        setReceivedReactions(prev => [reaction, ...prev]);
      }
    });

    return () => {
      channel.unsubscribe();
    };
  }, [fetchReactions, core, userId]);

  // リアクション送信
  const handleSend = async () => {
    if (!selectedFriendId) return;

    setLoading(true);
    setSuccess(false);
    try {
      await core.sendReaction(selectedFriendId, selectedEmoji, message || undefined);
      setSuccess(true);
      setMessage('');
      setTimeout(() => setSuccess(false), 2000);
    } catch (err: any) {
      console.error('送信エラー:', err);
      const message = err?.message || err?.error?.message || JSON.stringify(err);
      alert(`リアクションの送信に失敗しました: ${message}`);
    } finally {
      setLoading(false);
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
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold text-gray-800">リアクション</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-xl"
          >
            ✕
          </button>
        </div>

        {/* 送信フォーム */}
        {selectedFriendId && (
          <div className="p-4 border-b bg-blue-50">
            <p className="text-sm text-gray-700 mb-2">
              <span className="font-medium">{selectedFriendId}</span> にリアクションを送る
            </p>

            {/* 絵文字選択 */}
            <div className="flex gap-2 mb-3 flex-wrap">
              {EMOJI_OPTIONS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => setSelectedEmoji(emoji)}
                  className={`text-2xl p-2 rounded-lg transition ${
                    selectedEmoji === emoji
                      ? 'bg-blue-600 scale-110'
                      : 'bg-white hover:bg-gray-100'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>

            {/* メッセージ入力 */}
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="メッセージ（任意）"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 mb-3"
            />

            {/* 送信ボタン */}
            <button
              onClick={handleSend}
              disabled={loading}
              className={`w-full py-2 rounded-lg font-medium transition ${
                success
                  ? 'bg-green-600 text-white'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              } disabled:opacity-50`}
            >
              {success ? '送信しました!' : loading ? '送信中...' : `${selectedEmoji} を送信`}
            </button>
          </div>
        )}

        {/* 受信リアクション一覧 */}
        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">受信したリアクション</h3>
          {receivedReactions.length === 0 ? (
            <p className="text-gray-500 text-sm">まだリアクションがありません</p>
          ) : (
            <ul className="space-y-2">
              {receivedReactions.map(reaction => (
                <li
                  key={reaction.id}
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                >
                  <span className="text-3xl">{reaction.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-600 truncate">
                      {reaction.from_user_id.slice(0, 8)}...
                    </p>
                    {reaction.message && (
                      <p className="text-sm text-gray-800">{reaction.message}</p>
                    )}
                    <p className="text-xs text-gray-500">{formatTime(reaction.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
