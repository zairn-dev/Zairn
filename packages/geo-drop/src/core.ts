/**
 * @zen-map/geo-drop コアSDK
 * 場所に紐づいたデータドロップの作成・発見・アンロック
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  GeoDropOptions,
  GeoDropSDK,
  GeoDrop,
  GeoDropCreate,
  DropClaim,
  DropStatus,
  DropStats,
  NearbyDrop,
  NftMetadata,
  IpfsUploadResult,
  LocationProof,
} from './types';
import { IpfsClient } from './ipfs';
import { encrypt, decrypt, hashPassword, deriveLocationKey } from './crypto';
import { calculateDistance, encodeGeohash, decodeGeohash, verifyProximity } from './geofence';

/**
 * geo-drop SDKのメインファクトリ関数
 */
export function createGeoDrop(opts: GeoDropOptions): GeoDropSDK {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey);
  const ipfs = new IpfsClient(opts.ipfs);

  const getUserId = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error('Not authenticated');
    return data.user.id;
  };

  // =====================
  // IPFS
  // =====================
  const uploadToIpfs = async (content: File | Blob | string): Promise<IpfsUploadResult> => {
    return ipfs.upload(content);
  };

  const fetchFromIpfs = async (cid: string): Promise<string> => {
    return ipfs.fetch(cid);
  };

  // =====================
  // ドロップ作成
  // =====================
  const createDrop = async (data: GeoDropCreate, content: File | Blob | string): Promise<GeoDrop> => {
    const userId = await getUserId();
    const geohash = encodeGeohash(data.lat, data.lon);
    const unlockRadius = data.unlock_radius_meters ?? 50;

    // パスワードハッシュ
    let passwordHash: string | null = null;
    if (data.password) {
      passwordHash = await hashPassword(data.password);
    }

    // コンテンツを暗号化してIPFSにアップロード
    const contentStr = typeof content === 'string'
      ? content
      : await new Response(content).text();

    // 位置ベースの暗号化キーを生成
    // 暗号化ソルトはドロップごとにランダム
    const encSalt = crypto.getRandomValues(new Uint8Array(16));
    const encSaltStr = Array.from(encSalt).map(b => b.toString(16).padStart(2, '0')).join('');
    const locationKey = deriveLocationKey(geohash, encSaltStr, encSaltStr);

    const encrypted = await encrypt(contentStr, locationKey);
    const encryptedJson = JSON.stringify(encrypted);

    // IPFSにアップロード
    const ipfsResult = await ipfs.upload(encryptedJson);

    // DBに保存
    const { data: drop, error } = await supabase
      .from('geo_drops')
      .insert({
        creator_id: userId,
        lat: data.lat,
        lon: data.lon,
        geohash,
        unlock_radius_meters: unlockRadius,
        title: data.title,
        description: data.description ?? null,
        content_type: data.content_type,
        ipfs_cid: ipfsResult.cid,
        encrypted: true,
        encryption_salt: encSaltStr,
        visibility: data.visibility ?? 'public',
        password_hash: passwordHash,
        max_claims: data.max_claims ?? null,
        expires_at: data.expires_at?.toISOString() ?? null,
        preview_url: ipfs.getUrl(ipfsResult.cid),
        metadata: data.metadata ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return drop as GeoDrop;
  };

  // =====================
  // ドロップ取得
  // =====================
  const getDrop = async (dropId: string): Promise<GeoDrop | null> => {
    const { data, error } = await supabase
      .from('geo_drops')
      .select('*')
      .eq('id', dropId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as GeoDrop | null;
  };

  const getMyDrops = async (options?: { status?: DropStatus; limit?: number }): Promise<GeoDrop[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('geo_drops')
      .select('*')
      .eq('creator_id', userId)
      .order('created_at', { ascending: false });

    if (options?.status) query = query.eq('status', options.status);
    if (options?.limit) query = query.limit(options.limit);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as GeoDrop[];
  };

  const deleteDrop = async (dropId: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('geo_drops')
      .update({ status: 'deleted', updated_at: new Date().toISOString() })
      .eq('id', dropId)
      .eq('creator_id', userId);
    if (error) throw error;
  };

  // =====================
  // 発見・検索
  // =====================
  const findNearbyDrops = async (
    lat: number, lon: number, radiusMeters: number = 1000
  ): Promise<NearbyDrop[]> => {
    const userGeohash = encodeGeohash(lat, lon, 5); // precision 5 ≒ 5km範囲

    // geohashプレフィックスで大まかにフィルタ → 距離で絞り込み
    const { data, error } = await supabase
      .from('geo_drops')
      .select('*')
      .like('geohash', `${userGeohash}%`)
      .eq('status', 'active')
      .or('expires_at.is.null,expires_at.gt.now()');

    if (error) throw error;

    const nearby: NearbyDrop[] = [];
    for (const drop of (data ?? []) as GeoDrop[]) {
      const distance = calculateDistance(lat, lon, drop.lat, drop.lon);
      if (distance <= radiusMeters) {
        nearby.push({
          drop,
          distance_meters: Math.round(distance),
          can_unlock: distance <= drop.unlock_radius_meters,
        });
      }
    }

    return nearby.sort((a, b) => a.distance_meters - b.distance_meters);
  };

  // =====================
  // アンロック
  // =====================
  const unlockDrop = async (
    dropId: string,
    lat: number,
    lon: number,
    accuracy: number,
    password?: string
  ): Promise<{ content: string; claim: DropClaim }> => {
    const userId = await getUserId();
    const drop = await getDrop(dropId);
    if (!drop) throw new Error('Drop not found');
    if (drop.status !== 'active') throw new Error('Drop is not active');

    // 期限チェック
    if (drop.expires_at && new Date(drop.expires_at) <= new Date()) {
      throw new Error('Drop has expired');
    }

    // クレーム数チェック
    if (drop.max_claims !== null && drop.claim_count >= drop.max_claims) {
      throw new Error('Drop has reached maximum claims');
    }

    // パスワードチェック
    if (drop.password_hash) {
      if (!password) throw new Error('Password required');
      const hash = await hashPassword(password);
      if (hash !== drop.password_hash) throw new Error('Incorrect password');
    }

    // 位置検証
    const proof = verifyProximity({
      targetLat: drop.lat,
      targetLon: drop.lon,
      unlockRadius: drop.unlock_radius_meters,
      userLat: lat,
      userLon: lon,
      accuracy,
      userId,
    });

    if (!proof.verified) {
      throw new Error(`Too far from drop. Distance: ${proof.distance_to_target}m, Required: ${drop.unlock_radius_meters}m`);
    }

    // 重複クレームチェック
    const { data: existingClaim } = await supabase
      .from('drop_claims')
      .select('id')
      .eq('drop_id', dropId)
      .eq('user_id', userId)
      .limit(1);

    if (existingClaim && existingClaim.length > 0) {
      throw new Error('Already claimed this drop');
    }

    // IPFSからコンテンツを取得・復号
    const encryptedJson = await ipfs.fetch(drop.ipfs_cid);
    const encrypted = JSON.parse(encryptedJson);

    // 暗号化ソルトをDBから取得
    const { data: dropDetail } = await supabase
      .from('geo_drops')
      .select('encryption_salt')
      .eq('id', dropId)
      .single();

    const encSalt = (dropDetail as { encryption_salt: string })?.encryption_salt ?? '';
    const locationKey = deriveLocationKey(drop.geohash, encSalt, encSalt);
    const content = await decrypt(encrypted, locationKey);

    // クレーム記録
    const { data: claim, error: claimError } = await supabase
      .from('drop_claims')
      .insert({
        drop_id: dropId,
        user_id: userId,
        lat,
        lon,
        distance_meters: proof.distance_to_target,
      })
      .select()
      .single();

    if (claimError) throw claimError;

    // クレーム数を更新
    await supabase
      .from('geo_drops')
      .update({
        claim_count: drop.claim_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', dropId);

    return { content, claim: claim as DropClaim };
  };

  // =====================
  // ジオフェンス検証
  // =====================
  const verifyLocation = async (
    dropId: string,
    lat: number,
    lon: number,
    accuracy: number
  ): Promise<LocationProof> => {
    const userId = await getUserId();
    const drop = await getDrop(dropId);
    if (!drop) throw new Error('Drop not found');

    return verifyProximity({
      targetLat: drop.lat,
      targetLon: drop.lon,
      unlockRadius: drop.unlock_radius_meters,
      userLat: lat,
      userLon: lon,
      accuracy,
      userId,
    });
  };

  // =====================
  // クレーム
  // =====================
  const getDropClaims = async (dropId: string): Promise<DropClaim[]> => {
    const { data, error } = await supabase
      .from('drop_claims')
      .select('*')
      .eq('drop_id', dropId)
      .order('claimed_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as DropClaim[];
  };

  const getMyClaims = async (options?: { limit?: number }): Promise<DropClaim[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('drop_claims')
      .select('*')
      .eq('user_id', userId)
      .order('claimed_at', { ascending: false });

    if (options?.limit) query = query.limit(options.limit);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as DropClaim[];
  };

  // =====================
  // 統計
  // =====================
  const getMyStats = async (): Promise<DropStats> => {
    const userId = await getUserId();

    const [created, claimed, active] = await Promise.all([
      supabase.from('geo_drops').select('id', { count: 'exact', head: true }).eq('creator_id', userId),
      supabase.from('drop_claims').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('geo_drops').select('id', { count: 'exact', head: true }).eq('creator_id', userId).eq('status', 'active'),
    ]);

    // ユニークな場所数（geohash precision 5 でグループ化）
    const { data: locations } = await supabase
      .from('geo_drops')
      .select('geohash')
      .eq('creator_id', userId);

    const uniqueGeo = new Set((locations ?? []).map((l: { geohash: string }) => l.geohash.substring(0, 5)));

    return {
      total_created: created.count ?? 0,
      total_claimed: claimed.count ?? 0,
      total_active: active.count ?? 0,
      unique_locations: uniqueGeo.size,
    };
  };

  // =====================
  // NFTメタデータ生成
  // =====================
  const generateNftMetadata = (drop: GeoDrop, imageUrl?: string): NftMetadata => {
    return {
      name: drop.title,
      description: drop.description ?? `A geo-drop at ${drop.lat.toFixed(4)}, ${drop.lon.toFixed(4)}`,
      image: imageUrl ?? drop.preview_url ?? '',
      attributes: [
        { trait_type: 'Content Type', value: drop.content_type },
        { trait_type: 'Latitude', value: Number(drop.lat.toFixed(6)) },
        { trait_type: 'Longitude', value: Number(drop.lon.toFixed(6)) },
        { trait_type: 'Unlock Radius', value: `${drop.unlock_radius_meters}m` },
        { trait_type: 'Geohash', value: drop.geohash },
        { trait_type: 'Total Claims', value: drop.claim_count },
        { trait_type: 'Created', value: drop.created_at },
      ],
      geo_drop: {
        lat: drop.lat,
        lon: drop.lon,
        geohash: drop.geohash,
        drop_id: drop.id,
        ipfs_cid: drop.ipfs_cid,
      },
    };
  };

  return {
    createDrop,
    getDrop,
    getMyDrops,
    deleteDrop,
    findNearbyDrops,
    unlockDrop,
    getDropClaims,
    getMyClaims,
    getMyStats,
    uploadToIpfs,
    fetchFromIpfs,
    verifyLocation,
    generateNftMetadata,
    encodeGeohash,
    decodeGeohash,
    calculateDistance,
  };
}
