'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ChatRoom, Message, createLocationCore } from '@zen-map/sdk';

interface ChatPanelProps {
  userId: string;
  selectedFriendId?: string | null;
  onClose: () => void;
}

export default function ChatPanel({ userId, selectedFriendId, onClose }: ChatPanelProps) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [roomMembers, setRoomMembers] = useState<Record<string, string[]>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const core = useMemo(() => createLocationCore({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  }), []);

  // チャットルーム一覧を取得
  const fetchRooms = useCallback(async () => {
    try {
      const chatRooms = await core.getChatRooms();
      setRooms(chatRooms);

      // 各ルームのメンバーを取得
      const members: Record<string, string[]> = {};
      for (const room of chatRooms) {
        members[room.id] = await core.getChatRoomMembers(room.id);
      }
      setRoomMembers(members);
    } catch (err) {
      console.error('チャットルーム取得エラー:', err);
    }
  }, [core]);

  // 初期化時に友達とのチャットを開く
  useEffect(() => {
    const init = async () => {
      await fetchRooms();
      if (selectedFriendId) {
        try {
          const room = await core.getOrCreateDirectChat(selectedFriendId);
          setCurrentRoom(room);
        } catch (err) {
          console.error('チャット作成エラー:', err);
        }
      }
    };
    init();
  }, [fetchRooms, selectedFriendId, core]);

  // メッセージを取得
  useEffect(() => {
    if (!currentRoom) return;

    const fetchMessages = async () => {
      try {
        const msgs = await core.getMessages(currentRoom.id, { limit: 50 });
        setMessages(msgs.reverse());
        await core.markAsRead(currentRoom.id);
      } catch (err) {
        console.error('メッセージ取得エラー:', err);
      }
    };

    fetchMessages();

    // Realtimeで新着メッセージを購読
    const channel = core.subscribeMessages(currentRoom.id, (message) => {
      setMessages(prev => [...prev, message]);
    });

    return () => {
      channel.unsubscribe();
    };
  }, [currentRoom, core]);

  // スクロールを最下部に
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // メッセージ送信
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoom || !newMessage.trim()) return;

    setLoading(true);
    try {
      await core.sendMessage(currentRoom.id, newMessage.trim());
      setNewMessage('');
    } catch (err) {
      console.error('送信エラー:', err);
    } finally {
      setLoading(false);
    }
  };

  // ルーム名を取得（相手のID表示）
  const getRoomDisplayName = (room: ChatRoom) => {
    if (room.type === 'group') return 'グループチャット';
    const members = roomMembers[room.id] || [];
    const otherMember = members.find(id => id !== userId);
    return otherMember ? `${otherMember.slice(0, 8)}...` : 'チャット';
  };

  return (
    <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-scrim/50">
      <div className="bg-surface-container-lowest rounded-lg shadow-xl w-full max-w-2xl h-[80vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b border-outline-variant">
          <h2 className="text-lg font-bold text-on-surface">
            {currentRoom ? getRoomDisplayName(currentRoom) : 'チャット'}
          </h2>
          <div className="flex items-center gap-2">
            {currentRoom && (
              <button
                onClick={() => setCurrentRoom(null)}
                className="text-on-surface-variant hover:text-on-surface px-2"
              >
                一覧に戻る
              </button>
            )}
            <button
              onClick={onClose}
              className="text-on-surface-variant hover:text-on-surface text-xl"
            >
              ✕
            </button>
          </div>
        </div>

        {/* コンテンツ */}
        {!currentRoom ? (
          // ルーム一覧
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-sm font-medium text-on-surface-variant mb-2">チャット一覧</h3>
            {rooms.length === 0 ? (
              <p className="text-outline text-sm">チャットがありません</p>
            ) : (
              <ul className="space-y-2">
                {rooms.map(room => (
                  <li key={room.id}>
                    <button
                      onClick={() => setCurrentRoom(room)}
                      className="w-full p-3 bg-surface-container hover:bg-surface-container-high rounded-lg text-left"
                    >
                      <div className="font-medium text-on-surface">
                        {getRoomDisplayName(room)}
                      </div>
                      <div className="text-xs text-outline">
                        {room.type === 'direct' ? '1対1' : 'グループ'}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          // メッセージ表示
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex ${msg.sender_id === userId ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] px-4 py-2 rounded-lg ${
                      msg.sender_id === userId
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container-highest text-on-surface'
                    }`}
                  >
                    <p className="break-words">{msg.content}</p>
                    <p className={`text-xs mt-1 ${
                      msg.sender_id === userId ? 'text-on-primary/60' : 'text-outline'
                    }`}>
                      {new Date(msg.created_at).toLocaleTimeString('ja-JP', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* 入力欄 */}
            <form onSubmit={handleSend} className="p-4 border-t border-outline-variant">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="メッセージを入力..."
                  className="flex-1 px-4 py-2 border border-outline-variant rounded-full text-on-surface bg-surface-container-lowest focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  type="submit"
                  disabled={loading || !newMessage.trim()}
                  className="px-6 py-2 bg-primary text-on-primary rounded-full hover:brightness-90 disabled:opacity-50"
                >
                  送信
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
