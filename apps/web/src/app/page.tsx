'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { createClient } from '@/lib/supabase';
import AuthForm from '@/components/AuthForm';
import FriendsPanel from '@/components/FriendsPanel';
import ChatPanel from '@/components/ChatPanel';
import ReactionPanel from '@/components/ReactionPanel';
import BumpPanel from '@/components/BumpPanel';

// Leafletはクライアントサイドのみで動作するためdynamic importを使用
const Map = dynamic(() => import('@/components/Map'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-gray-100">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
    </div>
  ),
});

type PanelType = 'chat' | 'reaction' | 'bump' | null;

export default function Home() {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lon: number } | null>(null);

  const supabase = createClient();

  useEffect(() => {
    // 初期認証状態を確認
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUserId(user?.id || null);
      setLoading(false);
    };
    checkAuth();

    // 認証状態の変化を監視
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id || null);
    });

    return () => subscription.unsubscribe();
  }, [supabase.auth]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserId(null);
  };

  const openChat = (friendId: string) => {
    setSelectedFriendId(friendId);
    setActivePanel('chat');
  };

  const openReaction = (friendId: string) => {
    setSelectedFriendId(friendId);
    setActivePanel('reaction');
  };

  const closePanel = () => {
    setActivePanel(null);
    setSelectedFriendId(null);
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!userId) {
    return <AuthForm onSuccess={() => {}} />;
  }

  return (
    <div className="h-screen relative">
      {/* ログアウトボタン */}
      <button
        onClick={handleLogout}
        className="fixed top-4 left-4 z-[1000] bg-white px-4 py-2 rounded-lg shadow-lg hover:bg-gray-100 text-gray-700 text-sm"
      >
        ログアウト
      </button>

      {/* 機能ボタン */}
      <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-[1000] flex gap-2">
        <button
          onClick={() => setActivePanel('chat')}
          className="bg-blue-600 text-white px-4 py-3 rounded-full shadow-lg hover:bg-blue-700 flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          チャット
        </button>
        <button
          onClick={() => setActivePanel('reaction')}
          className="bg-yellow-500 text-white px-4 py-3 rounded-full shadow-lg hover:bg-yellow-600 flex items-center gap-2"
        >
          <span className="text-lg">👋</span>
          リアクション
        </button>
        <button
          onClick={() => setActivePanel('bump')}
          className="bg-purple-600 text-white px-4 py-3 rounded-full shadow-lg hover:bg-purple-700 flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Bump
        </button>
      </div>

      {/* 友達管理パネル */}
      <FriendsPanel userId={userId} />

      {/* 地図 */}
      <Map
        userId={userId}
        onOpenChat={openChat}
        onOpenReaction={openReaction}
        onLocationUpdate={setCurrentLocation}
      />

      {/* チャットパネル */}
      {activePanel === 'chat' && (
        <ChatPanel
          userId={userId}
          selectedFriendId={selectedFriendId}
          onClose={closePanel}
        />
      )}

      {/* リアクションパネル */}
      {activePanel === 'reaction' && (
        <ReactionPanel
          userId={userId}
          selectedFriendId={selectedFriendId}
          onClose={closePanel}
        />
      )}

      {/* Bumpパネル */}
      {activePanel === 'bump' && (
        <BumpPanel
          userId={userId}
          currentLocation={currentLocation}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
