/**
 * @zen-map/geo-drop Core SDK
 * Creation, discovery, and unlocking of location-bound data drops
 */
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
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
  ProofConfig,
  ProofSubmission,
  VerificationResult,
  RecoveredDrop,
  PersistenceLevel,
} from './types';
import { IpfsClient } from './ipfs';
import { encrypt, decrypt, hashPassword, deriveLocationKey } from './crypto';
import { calculateDistance, encodeGeohash, decodeGeohash, isMovementRealistic, geohashNeighbors } from './geofence';
import { createVerificationEngine } from './verification';
import { createPersistenceManager } from './persistence';
import { createChainClient } from './chain';

const DEFAULT_SIMILARITY_THRESHOLD = 0.70;
const GPS_ONLY_CONFIG: ProofConfig = { mode: 'all', requirements: [{ method: 'gps', params: {} }] };

/**
 * Main factory function for the geo-drop SDK
 */
export function createGeoDrop(opts: GeoDropOptions): GeoDropSDK {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey);
  const hasIpfs = !!(opts.ipfs?.pinningApiKey || opts.ipfs?.pinningService);
  const ipfs = new IpfsClient(opts.ipfs);

  // =====================
  // Auth helpers
  // =====================

  const getUserId = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error('Not authenticated');
    return data.user.id;
  };

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': opts.supabaseAnonKey,
    };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }
    return headers;
  };

  // =====================
  // Verification engine
  // =====================

  const verificationEngine = createVerificationEngine({
    imageProofUrl: opts.imageProofUrl ?? `${opts.supabaseUrl}/functions/v1/image-proof`,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    getAuthHeaders,
  });

  // Register initially provided custom verifiers
  if (opts.verifiers) {
    for (const [key, fn] of Object.entries(opts.verifiers)) {
      verificationEngine.register(key, fn);
    }
  }

  // =====================
  // Persistence manager
  // =====================

  const chainClient = opts.persistence?.chain ? createChainClient(opts.persistence.chain) : undefined;
  const persistenceManager = createPersistenceManager(ipfs, chainClient);
  const defaultPersistenceLevel: PersistenceLevel = opts.persistence?.level ?? 'db-only';
  const persistenceStrict = opts.persistence?.strict ?? false;

  // =====================
  // GPS spoofing detection
  // =====================

  const logLocation = async (userId: string, lat: number, lon: number, action: string): Promise<void> => {
    await supabase.from('drop_location_logs').insert({
      user_id: userId, lat, lon, geohash: encodeGeohash(lat, lon), action,
    });
  };

  const checkAntiSpoof = async (userId: string, lat: number, lon: number): Promise<void> => {
    const { data: logs } = await supabase
      .from('drop_location_logs')
      .select('lat, lon, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (logs && logs.length > 0) {
      const prev = logs[0];
      if (!isMovementRealistic(prev.lat, prev.lon, prev.created_at, lat, lon, new Date().toISOString())) {
        throw new Error('Suspicious movement detected. Location change too fast.');
      }
    }
  };

  // =====================
  // Drop creation
  // =====================

  const createDrop = async (data: GeoDropCreate, content: File | Blob | string): Promise<GeoDrop> => {
    const userId = await getUserId();
    const geohash = encodeGeohash(data.lat, data.lon);

    await logLocation(userId, data.lat, data.lon, 'create');

    // Pre-generate UUID (dropId is needed for encryption key derivation)
    const dropId = crypto.randomUUID();

    // Encrypt content
    const contentStr = typeof content === 'string' ? content : await new Response(content).text();
    const encSalt = crypto.getRandomValues(new Uint8Array(16));
    const encSaltStr = Array.from(encSalt).map(b => b.toString(16).padStart(2, '0')).join('');
    const locationKey = deriveLocationKey(geohash, dropId, encSaltStr);
    const encryptedPayload = await encrypt(contentStr, locationKey);
    const encryptedJson = JSON.stringify(encryptedPayload);

    // Upload to IPFS if configured, otherwise store in DB
    let ipfsCid: string | null = null;
    let encryptedContent: string | null = null;
    let previewUrl: string | null = null;

    if (hasIpfs) {
      const ipfsResult = await ipfs.upload(encryptedJson);
      ipfsCid = ipfsResult.cid;
      previewUrl = ipfs.getUrl(ipfsResult.cid);
    } else {
      // DB-only mode: store encrypted content directly
      encryptedContent = encryptedJson;
    }

    const { data: drop, error } = await supabase
      .from('geo_drops')
      .insert({
        id: dropId,
        creator_id: userId,
        lat: data.lat,
        lon: data.lon,
        geohash,
        unlock_radius_meters: data.unlock_radius_meters ?? 50,
        title: data.title,
        description: data.description ?? null,
        content_type: data.content_type,
        ipfs_cid: ipfsCid,
        encrypted_content: encryptedContent,
        encrypted: true,
        encryption_salt: encSaltStr,
        visibility: data.visibility ?? 'public',
        password_hash: data.password ? await hashPassword(data.password) : null,
        max_claims: data.max_claims ?? null,
        proof_config: data.proof_config ?? null,
        expires_at: data.expires_at?.toISOString() ?? null,
        preview_url: previewUrl,
        metadata: data.metadata ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    const createdDrop = drop as GeoDrop;

    // Register sharing targets for private drops
    if (data.visibility === 'private' && data.shared_with?.length) {
      await supabase.from('drop_shares').insert(
        data.shared_with.map(uid => ({ drop_id: createdDrop.id, user_id: uid }))
      );
    }

    // Persistence (save metadata outside DB)
    const level = data.persistence ?? defaultPersistenceLevel;
    if (level !== 'db-only') {
      try {
        const pResult = await persistenceManager.persist(createdDrop, level, data.recoverySecret);
        // Also record persistence info in DB (for reference; not required for recovery)
        await supabase
          .from('geo_drops')
          .update({
            persistence_level: pResult.level,
            metadata_cid: pResult.metadataCid ?? null,
            chain_tx_hash: pResult.txHash ?? null,
          })
          .eq('id', createdDrop.id);
        createdDrop.persistence_level = pResult.level;
        createdDrop.metadata_cid = pResult.metadataCid;
        createdDrop.chain_tx_hash = pResult.txHash;
      } catch (e) {
        if (persistenceStrict) throw e;
        // If not strict, drop is already saved in DB so continue
      }
    }

    return createdDrop;
  };

  // =====================
  // Drop retrieval
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
    const { data, error } = await supabase
      .from('geo_drops')
      .update({ status: 'deleted', updated_at: new Date().toISOString() })
      .eq('id', dropId)
      .eq('creator_id', userId)
      .select('id')
      .single();
    if (error && error.code === 'PGRST116') throw new Error('Drop not found or not owned by you');
    if (error) throw error;
  };

  // =====================
  // Private sharing
  // =====================

  const shareDrop = async (dropId: string, userIds: string[]): Promise<void> => {
    const userId = await getUserId();
    const drop = await getDrop(dropId);
    if (!drop || drop.creator_id !== userId) throw new Error('Not the drop creator');

    const { error } = await supabase.from('drop_shares').upsert(
      userIds.map(uid => ({ drop_id: dropId, user_id: uid }))
    );
    if (error) throw error;
  };

  const unshareDrop = async (dropId: string, userId: string): Promise<void> => {
    const myId = await getUserId();
    const drop = await getDrop(dropId);
    if (!drop || drop.creator_id !== myId) throw new Error('Not the drop creator');

    const { error } = await supabase
      .from('drop_shares')
      .delete()
      .eq('drop_id', dropId)
      .eq('user_id', userId);
    if (error) throw error;
  };

  const getSharedDrops = async (): Promise<GeoDrop[]> => {
    const userId = await getUserId();
    const { data: shares, error: sharesError } = await supabase
      .from('drop_shares')
      .select('drop_id')
      .eq('user_id', userId);
    if (sharesError) throw sharesError;
    if (!shares?.length) return [];

    const { data, error } = await supabase
      .from('geo_drops')
      .select('*')
      .in('id', shares.map(s => s.drop_id))
      .eq('status', 'active');
    if (error) throw error;
    return (data ?? []) as GeoDrop[];
  };

  // =====================
  // Discovery & search
  // =====================

  const findNearbyDrops = async (lat: number, lon: number, radiusMeters: number = 1000): Promise<NearbyDrop[]> => {
    const userId = await getUserId();
    const userGeohash = encodeGeohash(lat, lon, 5);

    // Geohash boundary fix: also search center + 8 adjacent geohashes
    const prefixes = [...new Set([...geohashNeighbors(userGeohash), userGeohash])];
    const orFilter = prefixes.map(p => `geohash.like.${p}%`).join(',');

    const { data, error } = await supabase
      .from('geo_drops')
      .select('*')
      .eq('status', 'active')
      .or(orFilter)
      .or('expires_at.is.null,expires_at.gt.now()');

    if (error) throw error;

    await logLocation(userId, lat, lon, 'search');

    return (data ?? [] as GeoDrop[])
      .map(d => {
        const drop = d as GeoDrop;
        const distance = calculateDistance(lat, lon, drop.lat, drop.lon);
        return { drop, distance_meters: Math.round(distance), can_unlock: distance <= drop.unlock_radius_meters };
      })
      .filter(n => n.distance_meters <= radiusMeters)
      .sort((a, b) => a.distance_meters - b.distance_meters);
  };

  // =====================
  // Unlock
  // =====================

  const unlockDrop = async (
    dropId: string,
    lat: number,
    lon: number,
    accuracy: number,
    password?: string,
    proofs?: ProofSubmission[]
  ): Promise<{ content: string; claim: DropClaim; verification: VerificationResult }> => {
    const userId = await getUserId();

    await checkAntiSpoof(userId, lat, lon);
    await logLocation(userId, lat, lon, 'unlock_attempt');

    const drop = await getDrop(dropId);
    if (!drop) throw new Error('Drop not found');
    if (drop.status !== 'active') throw new Error('Drop is not active');
    if (drop.expires_at && new Date(drop.expires_at) <= new Date()) throw new Error('Drop has expired');
    // Password check
    if (drop.password_hash) {
      if (!password) throw new Error('Password required');
      if (await hashPassword(password) !== drop.password_hash) throw new Error('Incorrect password');
    }

    // Pluggable verification
    const proofConfig = drop.proof_config ?? GPS_ONLY_CONFIG;
    const allSubmissions: ProofSubmission[] = [
      { method: 'gps', data: { lat, lon, accuracy, user_id: userId } },
      ...(proofs ?? []),
    ];

    const verification = await verificationEngine.verify(drop, proofConfig, allSubmissions);
    if (!verification.verified) {
      const failed = verification.proofs.filter(p => !p.verified).map(p => p.method);
      throw new Error(`Verification failed for: ${failed.join(', ')}`);
    }

    // Atomically check max_claims and increment at SQL level (prevents race conditions)
    const { data: incremented, error: rpcError } = await supabase.rpc('increment_claim_count', { drop_id: dropId });
    if (rpcError) throw rpcError;
    if (incremented === false) throw new Error('Drop has reached maximum claims');

    // Decrypt content — from IPFS or DB depending on storage mode
    let encryptedJson: string;
    if (drop.ipfs_cid) {
      encryptedJson = await ipfs.fetch(drop.ipfs_cid);
    } else if (drop.encrypted_content) {
      encryptedJson = drop.encrypted_content;
    } else {
      throw new Error('Drop has no content (neither IPFS CID nor encrypted_content)');
    }
    const locationKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt ?? '');
    const content = await decrypt(JSON.parse(encryptedJson), locationKey);

    // Distance (from GPS result or calculated)
    const gpsProof = verification.proofs.find(p => p.method === 'gps');
    const distanceMeters = (gpsProof?.details.distance_meters as number)
      ?? Math.round(calculateDistance(lat, lon, drop.lat, drop.lon));

    // Record claim (unique constraint prevents duplicates)
    const { data: claim, error: claimError } = await supabase
      .from('drop_claims')
      .insert({
        drop_id: dropId,
        user_id: userId,
        lat,
        lon,
        distance_meters: distanceMeters,
        proof_results: verification.proofs,
      })
      .select()
      .single();
    if (claimError) {
      // Unique constraint violation = already claimed -> no need to revert count (treated as idempotent)
      if (claimError.code === '23505') throw new Error('Already claimed this drop');
      throw claimError;
    }

    return { content, claim: claim as DropClaim, verification };
  };

  // =====================
  // Geofence verification (standalone)
  // =====================

  const verifyLocation = async (dropId: string, lat: number, lon: number, accuracy: number): Promise<LocationProof> => {
    const userId = await getUserId();
    const drop = await getDrop(dropId);
    if (!drop) throw new Error('Drop not found');

    const { verifyProximity } = await import('./geofence');
    return verifyProximity({
      targetLat: drop.lat, targetLon: drop.lon, unlockRadius: drop.unlock_radius_meters,
      userLat: lat, userLon: lon, accuracy, userId,
    });
  };

  // =====================
  // Claims & stats
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

  const getMyStats = async (): Promise<DropStats> => {
    const userId = await getUserId();

    const [created, claimed, active] = await Promise.all([
      supabase.from('geo_drops').select('id', { count: 'exact', head: true }).eq('creator_id', userId),
      supabase.from('drop_claims').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('geo_drops').select('id', { count: 'exact', head: true }).eq('creator_id', userId).eq('status', 'active'),
    ]);

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
  // Realtime
  // =====================

  const subscribeNearbyDrops = (
    lat: number, lon: number, radiusMeters: number, onDrop: (drop: GeoDrop) => void
  ): RealtimeChannel => {
    const userGeohash = encodeGeohash(lat, lon, 5);
    const prefixes = new Set([...geohashNeighbors(userGeohash), userGeohash]);

    return supabase
      .channel('geo_drops_nearby')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'geo_drops' },
        (payload) => {
          const drop = payload.new as GeoDrop;
          const dropPrefix = drop.geohash?.substring(0, 5);
          if (!dropPrefix || !prefixes.has(dropPrefix)) return;
          if (calculateDistance(lat, lon, drop.lat, drop.lon) <= radiusMeters) {
            onDrop(drop);
          }
        }
      )
      .subscribe();
  };

  // =====================
  // NFT metadata
  // =====================

  const generateNftMetadata = (drop: GeoDrop, imageUrl?: string): NftMetadata => ({
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
      lat: drop.lat, lon: drop.lon, geohash: drop.geohash,
      drop_id: drop.id, ipfs_cid: drop.ipfs_cid ?? '',
    },
  });

  // =====================
  // Public API
  // =====================

  return {
    // Drop CRUD
    createDrop,
    getDrop,
    getMyDrops,
    deleteDrop,

    // Discovery & unlock
    findNearbyDrops,
    unlockDrop,

    // Verification
    getProofConfig: async (dropId: string) => (await getDrop(dropId))?.proof_config ?? null,
    registerVerifier: (methodOrId, verifier) => verificationEngine.register(methodOrId, verifier),
    extractImageEmbedding: (imageBase64) => verificationEngine.extractEmbedding(imageBase64),
    verifyImageProof: (imageBase64, dropId, threshold) => verificationEngine.verifyImage(imageBase64, dropId, threshold),

    // Sharing
    shareDrop,
    unshareDrop,
    getSharedDrops,

    // Claims & stats
    getDropClaims,
    getMyClaims,
    getMyStats,

    // IPFS
    uploadToIpfs: (content) => {
      if (!hasIpfs) throw new Error('IPFS is not configured. Provide ipfs config with pinningApiKey to use IPFS features.');
      return ipfs.upload(content);
    },
    fetchFromIpfs: (cid) => ipfs.fetch(cid),

    // Geofence
    verifyLocation,

    // Realtime
    subscribeNearbyDrops,

    // NFT
    generateNftMetadata,

    // DB-independent recovery
    recoverDrop: (metadataCid, recoverySecret?) =>
      persistenceManager.recoverFromCid(metadataCid, recoverySecret),

    discoverDropsByLocation: async (lat, lon, precision = 5) => {
      const centerHash = encodeGeohash(lat, lon, precision);
      const hashes = [centerHash, ...geohashNeighbors(centerHash)];
      const allResults: RecoveredDrop[] = [];
      for (const h of hashes) {
        const results = await persistenceManager.recoverFromChain(h);
        allResults.push(...results);
      }
      // Deduplicate by CID
      const seen = new Set<string>();
      return allResults.filter(r => {
        if (seen.has(r.metadataCid)) return false;
        seen.add(r.metadataCid);
        return true;
      });
    },

    decryptRecoveredDrop: async (recovered) => {
      const m = recovered.metadata;
      if (!m.dropId || !m.contentCid || !m.geohash) {
        throw new Error('Incomplete metadata. If the drop is encrypted, provide recoverySecret to recoverDrop() first.');
      }
      const encryptedJson = await ipfs.fetch(m.contentCid);
      const locationKey = deriveLocationKey(m.geohash, m.dropId, m.encryptionSalt);
      return decrypt(JSON.parse(encryptedJson), locationKey);
    },

    // Utilities
    encodeGeohash,
    decodeGeohash,
    calculateDistance,
  };
}
