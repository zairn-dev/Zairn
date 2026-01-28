'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createClient, LocationCurrentRow } from '@/lib/supabase';
import { createLocationCore } from '@/lib/location-core';

// Leafletのデフォルトアイコン問題を修正
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const myIcon = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const friendIcon = L.icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

L.Marker.prototype.options.icon = defaultIcon;

// 地図の中心を更新するコンポーネント
function MapUpdater({ center }: { center: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.setView(center, map.getZoom());
    }
  }, [center, map]);
  return null;
}

interface MapProps {
  userId: string;
  onSelectFriend?: (friendId: string) => void;
  onOpenChat?: (friendId: string) => void;
  onOpenReaction?: (friendId: string) => void;
  onLocationUpdate?: (location: { lat: number; lon: number }) => void;
}

export default function Map({ userId, onSelectFriend, onOpenChat, onOpenReaction, onLocationUpdate }: MapProps) {
  const [myLocation, setMyLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [friends, setFriends] = useState<LocationCurrentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);
  const core = useMemo(() => createLocationCore(supabase), [supabase]);

  // 友達の位置を取得
  const fetchFriends = useCallback(async () => {
    try {
      const data = await core.getVisibleFriends();
      const filtered = data.filter(f => f.user_id !== userId);
      console.log('getVisibleFriends:', data.length, '件 → フィルタ後:', filtered.length, '件');
      console.log('自分のID:', userId);
      console.log('位置データ:', data.map(d => ({ id: d.user_id, isMe: d.user_id === userId })));
      setFriends(filtered);
    } catch (err) {
      console.error('友達の位置取得エラー:', err);
    }
  }, [core, userId]);

  // 自分の位置を送信
  const sendMyLocation = useCallback(async (lat: number, lon: number, accuracy: number) => {
    try {
      await core.sendLocation(lat, lon, accuracy);
      setMyLocation({ lat, lon });
      onLocationUpdate?.({ lat, lon });
    } catch (err) {
      console.error('位置送信エラー:', err);
      setError('位置情報の送信に失敗しました');
    }
  }, [core, onLocationUpdate]);

  // 位置情報の取得と監視
  useEffect(() => {
    if (!navigator.geolocation) {
      setError('お使いのブラウザは位置情報に対応していません');
      setLoading(false);
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        sendMyLocation(latitude, longitude, accuracy);
        setLoading(false);
      },
      (err) => {
        setError(`位置情報の取得に失敗しました: ${err.message}`);
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [sendMyLocation]);

  // 友達の位置を定期的に取得
  useEffect(() => {
    fetchFriends();
    const interval = setInterval(fetchFriends, 10000);
    return () => clearInterval(interval);
  }, [fetchFriends]);

  // Realtime購読
  useEffect(() => {
    const channel = core.subscribeLocations((row) => {
      if (row.user_id !== userId) {
        setFriends(prev => {
          const exists = prev.find(f => f.user_id === row.user_id);
          if (exists) {
            return prev.map(f => f.user_id === row.user_id ? row : f);
          }
          return [...prev, row];
        });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [core, supabase, userId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">位置情報を取得中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-100">
        <div className="text-center text-red-600 p-4">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const center: [number, number] = myLocation
    ? [myLocation.lat, myLocation.lon]
    : [35.6812, 139.7671]; // デフォルト: 東京駅

  return (
    <MapContainer
      center={center}
      zoom={15}
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapUpdater center={myLocation ? [myLocation.lat, myLocation.lon] : null} />

      {/* 自分のマーカー */}
      {myLocation && (
        <Marker position={[myLocation.lat, myLocation.lon]} icon={myIcon}>
          <Popup>
            <strong>自分の位置</strong>
          </Popup>
        </Marker>
      )}

      {/* 友達のマーカー */}
      {friends.map((friend, index) => {
        // 自分と位置が近い場合はオフセットを適用
        let offsetLat = friend.lat;
        let offsetLon = friend.lon;

        if (myLocation) {
          const distance = Math.sqrt(
            Math.pow(friend.lat - myLocation.lat, 2) +
            Math.pow(friend.lon - myLocation.lon, 2)
          );
          // 約50m以内の場合はオフセット
          if (distance < 0.0005) {
            const angle = (index * 60 + 30) * (Math.PI / 180);
            offsetLat = friend.lat + 0.0003 * Math.cos(angle);
            offsetLon = friend.lon + 0.0003 * Math.sin(angle);
          }
        }

        return (
          <Marker
            key={friend.user_id}
            position={[offsetLat, offsetLon]}
            icon={friendIcon}
          >
            <Popup>
              <div className="min-w-[150px]">
                <strong className="block mb-2">友達</strong>
                <small className="text-gray-500 block mb-2">
                  {new Date(friend.updated_at).toLocaleString('ja-JP')}
                </small>
                <div className="flex gap-1 flex-wrap">
                  <button
                    onClick={() => onOpenChat?.(friend.user_id)}
                    className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
                  >
                    チャット
                  </button>
                  <button
                    onClick={() => onOpenReaction?.(friend.user_id)}
                    className="px-2 py-1 bg-yellow-500 text-white text-xs rounded hover:bg-yellow-600"
                  >
                    リアクション
                  </button>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
