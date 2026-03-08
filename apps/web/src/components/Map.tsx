'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocationCurrentRow, FavoritePlace, MotionType, createLocationCore } from '@zen-map/sdk';
import TrailLayer from './TrailLayer';

// バッテリー情報の型
interface BatteryManager {
  level: number;
  charging: boolean;
  addEventListener: (event: string, callback: () => void) => void;
  removeEventListener: (event: string, callback: () => void) => void;
}

// 滞在時間をフォーマット
function formatDuration(since: string | null): string {
  if (!since) return '';
  const now = new Date();
  const start = new Date(since);
  const diffMs = now.getTime() - start.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'たった今';
  if (diffMins < 60) return `${diffMins}分前から`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}時間前から`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}日前から`;
}

// 移動ステータスのアイコンとラベル
function getMotionInfo(motion: MotionType): { icon: string; label: string } {
  switch (motion) {
    case 'stationary': return { icon: '📍', label: '滞在中' };
    case 'walking': return { icon: '🚶', label: '徒歩' };
    case 'running': return { icon: '🏃', label: 'ランニング' };
    case 'cycling': return { icon: '🚴', label: '自転車' };
    case 'driving': return { icon: '🚗', label: '車' };
    case 'transit': return { icon: '🚃', label: '電車' };
    default: return { icon: '❓', label: '' };
  }
}

// バッテリーアイコン
function getBatteryIcon(level: number | null, isCharging: boolean): string {
  if (level === null) return '';
  if (isCharging) return '🔌';
  if (level > 80) return '🔋';
  if (level > 50) return '🔋';
  if (level > 20) return '🪫';
  return '🪫';
}

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
  showTrails?: boolean;
  demoTrails?: boolean;
  onSelectFriend?: (friendId: string) => void;
  onOpenChat?: (friendId: string) => void;
  onOpenReaction?: (friendId: string) => void;
  onLocationUpdate?: (location: { lat: number; lon: number }) => void;
}

type FriendWithPlace = LocationCurrentRow & { place?: FavoritePlace };

export default function Map({ userId, showTrails, demoTrails, onSelectFriend, onOpenChat, onOpenReaction, onLocationUpdate }: MapProps) {
  const [myLocation, setMyLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [friends, setFriends] = useState<FriendWithPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null);

  const core = useMemo(() => createLocationCore({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  }), []);

  // バッテリー情報の取得
  useEffect(() => {
    const getBattery = async () => {
      try {
        if ('getBattery' in navigator) {
          const batteryManager = await (navigator as any).getBattery() as BatteryManager;
          const updateBattery = () => {
            setBattery({
              level: Math.round(batteryManager.level * 100),
              charging: batteryManager.charging,
            });
          };
          updateBattery();
          batteryManager.addEventListener('levelchange', updateBattery);
          batteryManager.addEventListener('chargingchange', updateBattery);
          return () => {
            batteryManager.removeEventListener('levelchange', updateBattery);
            batteryManager.removeEventListener('chargingchange', updateBattery);
          };
        }
      } catch (e) {
        console.log('Battery API not available');
      }
    };
    getBattery();
  }, []);

  // 友達の位置を取得（お気に入りの場所付き）
  const fetchFriends = useCallback(async () => {
    try {
      const data = await core.getVisibleFriendsWithPlaces();
      const filtered = data.filter(f => f.user_id !== userId);
      setFriends(filtered);
    } catch (err) {
      console.error('友達の位置取得エラー:', err);
      // フォールバック: お気に入りなしで取得
      try {
        const fallbackData = await core.getVisibleFriends();
        setFriends(fallbackData.filter(f => f.user_id !== userId));
      } catch {
        // ignore
      }
    }
  }, [core, userId]);

  // 自分の位置を送信（バッテリー情報付き）
  const sendMyLocation = useCallback(async (lat: number, lon: number, accuracy: number, speed?: number | null) => {
    try {
      await core.sendLocationWithTrail({
        lat,
        lon,
        accuracy,
        battery_level: battery?.level ?? null,
        is_charging: battery?.charging ?? false,
        speed: speed ?? null,
      });
      setMyLocation({ lat, lon });
      onLocationUpdate?.({ lat, lon });
    } catch (err) {
      console.error('位置送信エラー:', err);
      setError('位置情報の送信に失敗しました');
    }
  }, [core, onLocationUpdate, battery]);

  // 位置情報の取得と監視
  useEffect(() => {
    if (!navigator.geolocation) {
      setError('お使いのブラウザは位置情報に対応していません');
      setLoading(false);
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, speed } = position.coords;
        sendMyLocation(latitude, longitude, accuracy, speed);
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
      core.supabase.removeChannel(channel);
    };
  }, [core, userId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-dim">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-on-surface-variant">位置情報を取得中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-dim">
        <div className="text-center text-error p-4">
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

      {/* 足跡レイヤー */}
      {showTrails && (
        <TrailLayer
          userId={userId}
          visible={!!showTrails}
          demo={!!demoTrails}
          center={myLocation}
        />
      )}

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
              <div className="min-w-[180px]">
                {/* お気に入りの場所 */}
                {friend.place && (
                  <div className="bg-primary-container text-on-primary-container px-2 py-1 rounded text-xs mb-2 inline-block">
                    {friend.place.icon || '📍'} {friend.place.name}
                  </div>
                )}

                <strong className="block mb-1">友達</strong>

                {/* 滞在時間と移動ステータス */}
                <div className="text-sm text-on-surface-variant mb-2">
                  {friend.motion && friend.motion !== 'unknown' && (
                    <span className="mr-2">
                      {getMotionInfo(friend.motion).icon} {getMotionInfo(friend.motion).label}
                    </span>
                  )}
                  {friend.location_since && (
                    <span>{formatDuration(friend.location_since)}</span>
                  )}
                </div>

                {/* バッテリー */}
                {friend.battery_level !== null && friend.battery_level !== undefined && (
                  <div className="text-sm mb-2">
                    {getBatteryIcon(friend.battery_level, friend.is_charging)} {friend.battery_level}%
                    {friend.is_charging && ' 充電中'}
                  </div>
                )}

                <small className="text-outline block mb-2">
                  {new Date(friend.updated_at).toLocaleString('ja-JP')}
                </small>
                <div className="flex gap-1 flex-wrap">
                  <button
                    onClick={() => onOpenChat?.(friend.user_id)}
                    className="px-2 py-1 bg-primary text-on-primary text-xs rounded hover:brightness-90"
                  >
                    チャット
                  </button>
                  <button
                    onClick={() => onOpenReaction?.(friend.user_id)}
                    className="px-2 py-1 bg-tertiary text-on-tertiary text-xs rounded hover:brightness-90"
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
