/**
 * @zairn/geo-drop Core SDK
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
  ProofMethodType,
  ProofSubmission,
  VerificationResult,
  RecoveredDrop,
  PersistenceLevel,
  StepUpRequired,
  UnlockResult,
} from './types';
import { IpfsClient } from './ipfs';
import { encrypt, decrypt, hashPassword, verifyPassword, deriveLocationKey, CURRENT_KEY_VERSION } from './crypto';
import type { KeyDerivationVersion } from './crypto';
import { calculateDistance, encodeGeohash, decodeGeohash, isMovementRealistic, geohashNeighbors } from './geofence';
import { computeTrustScore, gateTrustScore } from './trust-scorer';
import type { LocationPoint } from './types';
import { createVerificationEngine } from './verification';
import { createPersistenceManager } from './persistence';
import { createChainClient } from './chain';
import {
  createSession as createSbppSession,
  SbppSessionStore,
  sbppSearch,
  sbppMatch,
  sbppVerifyBinding,
  buildSbppChallengeDigest,
  generateIndexTokens,
} from './sbpp';
import type { SbppSession, EncryptedSearchConfig, LocationIndexTokens } from './sbpp';

const DEFAULT_SIMILARITY_THRESHOLD = 0.70;
const GPS_ONLY_CONFIG: ProofConfig = { mode: 'all', requirements: [{ method: 'gps', params: {} }] };

function validateCoords(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Invalid coordinates');
  }
}

/**
 * Main factory function for the geo-drop SDK
 */
export function createGeoDrop(opts: GeoDropOptions): GeoDropSDK {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey);
  const hasIpfs = !!(opts.ipfs?.pinningApiKey || opts.ipfs?.pinningService);
  const ipfs = new IpfsClient(opts.ipfs);

  // Build versioned secret map
  const secretMap: Map<number, string> = new Map();
  if (opts.encryptionSecrets) {
    for (const [v, s] of Object.entries(opts.encryptionSecrets)) {
      secretMap.set(Number(v), s);
    }
  }
  if (opts.encryptionSecret) {
    // Single secret goes to version 1 (or fills gap)
    if (!secretMap.has(1)) secretMap.set(1, opts.encryptionSecret);
  }
  const currentSecretVersion = opts.currentSecretVersion
    ?? (secretMap.size > 0 ? Math.max(...secretMap.keys()) : 1);
  const encryptionSecret = secretMap.get(currentSecretVersion) ?? opts.encryptionSecret;

  // Enforce secret requirement in production
  if (!encryptionSecret && !opts.serverUnlock && !opts.allowInsecureNoSecret) {
    throw new Error(
      '[geo-drop] encryptionSecret or encryptionSecrets is required for production. '
      + 'Set allowInsecureNoSecret: true for development only.'
    );
  }

  /** Resolve secret for a specific version (for decryption of old drops) */
  const getSecretForVersion = (version: number): string | undefined => {
    return secretMap.get(version) ?? encryptionSecret;
  };

  // SBPP session management
  const sbppSessionStore = new SbppSessionStore();
  const sbppSearchConfig: EncryptedSearchConfig | null = opts.encryptedSearchConfig ?? null;

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

  // Warn about db-only mode (data loss risk)
  if (defaultPersistenceLevel === 'db-only') {
    console.warn(
      '[geo-drop] persistence_level is "db-only". Drops will be lost if the database '
      + 'is destroyed. Set persistence.level to "ipfs" or "onchain" for production durability.'
    );
  }

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
    validateCoords(data.lat, data.lon);
    const userId = await getUserId();
    const geohash = encodeGeohash(data.lat, data.lon);

    await logLocation(userId, data.lat, data.lon, 'create');

    // Pre-generate UUID (dropId is needed for encryption key derivation)
    const dropId = crypto.randomUUID();

    // Encrypt content
    const contentStr = typeof content === 'string' ? content : await new Response(content).text();
    const encSalt = crypto.getRandomValues(new Uint8Array(16));
    const encSaltStr = Array.from(encSalt).map(b => b.toString(16).padStart(2, '0')).join('');
    const keyVersion = CURRENT_KEY_VERSION;
    const locationKey = deriveLocationKey(geohash, dropId, encSaltStr, encryptionSecret, keyVersion);
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
        key_derivation_version: keyVersion,
        encryption_algorithm: 'aes-256-gcm',
        server_secret_version: currentSecretVersion,
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
            pin_status: pResult.pinResults ?? null,
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

  // Exclude sensitive columns (encryption_salt, password_hash, encrypted_content)
  // These are only accessed server-side in the unlock-drop Edge Function
  const GEO_DROP_PUBLIC_COLUMNS = 'id,creator_id,title,description,content_type,lat,lon,geohash,unlock_radius_meters,visibility,max_claims,claim_count,proof_config,expires_at,status,preview_url,metadata,persistence_level,metadata_cid,chain_tx_hash,ipfs_cid,encrypted,created_at,updated_at';

  const getDrop = async (dropId: string): Promise<GeoDrop | null> => {
    const { data, error } = await supabase
      .from('geo_drops')
      .select(GEO_DROP_PUBLIC_COLUMNS)
      .eq('id', dropId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as GeoDrop | null;
  };

  const getMyDrops = async (options?: { status?: DropStatus; limit?: number }): Promise<GeoDrop[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('geo_drops')
      .select(GEO_DROP_PUBLIC_COLUMNS)
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

    const dropListColumns = 'id,creator_id,title,content_type,visibility,geohash,lat,lon,unlock_radius_meters,status,claim_count,max_claims,expires_at,created_at,updated_at,ipfs_cid,proof_config';
    const { data, error } = await supabase
      .from('geo_drops')
      .select(dropListColumns)
      .in('id', shares.map(s => s.drop_id))
      .eq('status', 'active');
    if (error) throw error;
    return (data ?? []) as GeoDrop[];
  };

  // =====================
  // Discovery & search
  // =====================

  const findNearbyDrops = async (lat: number, lon: number, radiusMeters: number = 1000): Promise<NearbyDrop[]> => {
    validateCoords(lat, lon);
    const userId = await getUserId();
    const userGeohash = encodeGeohash(lat, lon, 5);

    // Geohash boundary fix: also search center + 8 adjacent geohashes
    const prefixes = [...new Set([...geohashNeighbors(userGeohash), userGeohash])];
    const orFilter = prefixes.map(p => `geohash.like.${p}%`).join(',');

    // Exclude sensitive columns: encrypted_content, password_hash, encryption_salt
    const dropListColumns = 'id,creator_id,title,content_type,visibility,geohash,lat,lon,unlock_radius_meters,status,claim_count,max_claims,expires_at,created_at,updated_at,ipfs_cid,proof_config';
    const { data, error } = await supabase
      .from('geo_drops')
      .select(dropListColumns)
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

  // Resolve server unlock URL
  const serverUnlockUrl = opts.serverUnlock
    ? (typeof opts.serverUnlock === 'string' ? opts.serverUnlock : `${opts.supabaseUrl}/functions/v1/unlock-drop`)
    : null;

  const unlockDrop = async (
    dropId: string,
    lat: number,
    lon: number,
    accuracy: number,
    password?: string,
    proofs?: ProofSubmission[]
  ): Promise<UnlockResult> => {
    validateCoords(lat, lon);
    const userId = await getUserId();

    // --- Server-side unlock (recommended for production) ---
    if (serverUnlockUrl) {
      const headers = await getAuthHeaders();
      const res = await fetch(serverUnlockUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ drop_id: dropId, lat, lon, accuracy, password, proofs }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
        throw new Error(err.error);
      }
      const result = await res.json();
      // Server may return the legacy format (no type field) — normalize
      if (!result.type) result.type = 'success';
      return result as UnlockResult;
    }

    // --- Client-side unlock (for development / self-hosted without Edge Functions) ---
    // Trust scoring: fetch recent logs and compute trust score
    const { data: recentLogs } = await supabase
      .from('drop_location_logs')
      .select('lat, lon, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    const trustHistory: LocationPoint[] = (recentLogs ?? []).map(l => ({
      lat: l.lat, lon: l.lon, accuracy: null, timestamp: l.created_at,
    }));
    const trustResult = computeTrustScore(
      { lat, lon, accuracy: accuracy ?? null, timestamp: new Date().toISOString() },
      trustHistory,
    );
    const trustGate = gateTrustScore(trustResult);
    if (trustGate === 'deny') {
      throw new Error('Location trust check failed: suspicious location pattern detected');
    }

    await logLocation(userId, lat, lon, 'unlock_attempt');

    // Step-up: if trust is marginal, check whether the caller already provided
    // additional proofs. If not, return StepUpRequired so the client can prompt.
    if (trustGate === 'step-up') {
      const hasExtraProofs = (proofs ?? []).some(p => p.method !== 'gps');
      if (!hasExtraProofs) {
        // Determine which step-up methods the drop supports
        const dropForConfig = await getDrop(dropId);
        const proofConfig = dropForConfig?.proof_config ?? GPS_ONLY_CONFIG;
        const configuredMethods = proofConfig.requirements.map(r => r.method);
        const stepUpMethods: ProofMethodType[] = ['secret', 'ar', 'zkp', 'zkp-region']
          .filter(m => configuredMethods.includes(m as ProofMethodType)) as ProofMethodType[];
        // If drop has no extra methods configured, fall through and attempt GPS-only
        if (stepUpMethods.length > 0) {
          return {
            type: 'step-up-required',
            trustScore: trustResult.trustScore,
            reason: trustResult.spoofingSuspected
              ? 'Your GPS signal appears unstable. Please provide additional verification.'
              : 'Additional verification needed to confirm your location.',
            availableMethods: stepUpMethods,
            dropId,
          } satisfies StepUpRequired;
        }
      }
    }

    // Client-side unlock needs full row including encryption_salt, password_hash, encrypted_content
    // (getDrop uses GEO_DROP_PUBLIC_COLUMNS which excludes these)
    // Note: client-side unlock is for dev only; production uses serverUnlock
    const { data: drop, error: dropError } = await supabase
      .from('geo_drops')
      .select('*')
      .eq('id', dropId)
      .single();
    if (dropError && dropError.code === 'PGRST116') throw new Error('Drop not found');
    if (dropError) throw dropError;
    if (!drop) throw new Error('Drop not found');
    if (drop.status !== 'active') throw new Error('Drop is not active');
    if (drop.expires_at && new Date(drop.expires_at) <= new Date()) throw new Error('Drop has expired');
    // Password check
    if (drop.password_hash) {
      if (!password) throw new Error('Password required');
      if (!(await verifyPassword(password, drop.password_hash))) throw new Error('Incorrect password');
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
    const { data: incremented, error: rpcError } = await supabase.rpc('increment_claim_count', { p_drop_id: dropId });
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
    // Read encryption version info from DB (defaults for pre-migration drops)
    const dropRecord = drop as Record<string, unknown>;
    const kdVersion = (dropRecord.key_derivation_version as KeyDerivationVersion) ?? 1;
    const secretVer = (dropRecord.server_secret_version as number) ?? 1;
    const secret = getSecretForVersion(secretVer);
    const locationKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt ?? '', secret, kdVersion);
    const content = await decrypt(JSON.parse(encryptedJson), locationKey);

    // Distance (from GPS result or calculated)
    const gpsProof = verification.proofs.find(p => p.method === 'gps');
    const distanceMeters = (gpsProof?.details.distance_meters as number)
      ?? Math.round(calculateDistance(lat, lon, drop.lat, drop.lon));

    // Record claim (unique constraint prevents duplicates)
    // NOTE: When RLS is enabled, drop_claims INSERT requires service_role.
    // In production, use serverUnlock (Edge Function) which runs as service_role.
    // Client-side unlock is for development/testing only.
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
      // Always compensate the incremented count on any claim insert failure
      try { await supabase.rpc('decrement_claim_count', { p_drop_id: dropId }); } catch { /* best-effort */ }
      if (claimError.code === '23505') throw new Error('Already claimed this drop');
      throw claimError;
    }

    return { type: 'success', content, claim: claim as DropClaim, verification };
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
        // Note: Supabase Realtime requires tables, not views.
        // Sensitive columns are stripped in the callback below.
        { event: 'INSERT', schema: 'public', table: 'geo_drops' },
        (payload) => {
          const raw = payload.new as Record<string, unknown>;
          // Strip sensitive columns from the Realtime payload
          delete raw.encryption_salt;
          delete raw.password_hash;
          delete raw.encrypted_content;
          delete raw.server_secret_version;
          delete raw.key_derivation_version;
          const drop = raw as unknown as GeoDrop;
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

    // WARNING: This method bypasses location verification by design.
    // It is intended ONLY for disaster recovery when the service DB is unavailable
    // and the user has the IPFS metadata CID + recoverySecret.
    // Do NOT expose this in end-user UI without additional access control.
    decryptRecoveredDrop: async (recovered) => {
      const m = recovered.metadata;
      if (!m.dropId || !m.contentCid || !m.geohash) {
        throw new Error('Incomplete metadata. If the drop is encrypted, provide recoverySecret to recoverDrop() first.');
      }
      const encryptedJson = await ipfs.fetch(m.contentCid);
      // V2 metadata includes keyDerivationVersion and serverSecretVersion
      const kdVer = ('keyDerivationVersion' in m ? m.keyDerivationVersion : 1) as KeyDerivationVersion;
      const secretVer = ('serverSecretVersion' in m ? m.serverSecretVersion : 1) as number;
      const secret = getSecretForVersion(secretVer);
      if (!secret) {
        throw new Error(`Encryption secret for version ${secretVer} not configured. Provide encryptionSecrets in SDK options.`);
      }
      const locationKey = deriveLocationKey(m.geohash, m.dropId, m.encryptionSalt, secret, kdVer);
      return decrypt(JSON.parse(encryptedJson), locationKey);
    },

    /**
     * Re-encrypt a drop with a new server secret version.
     * Used during key rotation to migrate old drops to the new secret.
     * Only the drop creator can re-encrypt.
     */
    reEncryptDrop: async (dropId: string, oldSecretVer: number, newSecretVer: number) => {
      const userId = await getUserId();
      const { data: drop, error } = await supabase
        .from('geo_drops')
        .select('id, creator_id, geohash, encryption_salt, encrypted_content, ipfs_cid, key_derivation_version, server_secret_version')
        .eq('id', dropId)
        .single();
      if (error || !drop) throw new Error('Drop not found');
      if (drop.creator_id !== userId) throw new Error('Only the creator can re-encrypt');

      const oldSecret = getSecretForVersion(oldSecretVer);
      const newSecret = getSecretForVersion(newSecretVer);
      if (!oldSecret || !newSecret) throw new Error('Secret version not found in secretMap');

      const kdVer = (drop.key_derivation_version ?? 1) as KeyDerivationVersion;
      const oldKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt ?? '', oldSecret, kdVer);

      // Fetch encrypted content
      let encryptedJson: string;
      if (drop.ipfs_cid) {
        encryptedJson = await ipfs.fetch(drop.ipfs_cid);
      } else if (drop.encrypted_content) {
        encryptedJson = drop.encrypted_content;
      } else {
        throw new Error('No encrypted content found');
      }

      // Decrypt with old key
      const plaintext = await decrypt(JSON.parse(encryptedJson), oldKey);

      // Re-encrypt with new key (use current key derivation version)
      const newKdVer = CURRENT_KEY_VERSION;
      const newKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt ?? '', newSecret, newKdVer);
      const newPayload = await encrypt(plaintext, newKey);
      const newEncryptedJson = JSON.stringify(newPayload);

      // Update DB
      const updateData: Record<string, unknown> = {
        key_derivation_version: newKdVer,
        server_secret_version: newSecretVer,
        updated_at: new Date().toISOString(),
      };

      if (drop.ipfs_cid) {
        if (!hasIpfs) {
          throw new Error('Cannot re-encrypt IPFS drop without IPFS configuration');
        }
        const result = await ipfs.upload(newEncryptedJson);
        updateData.ipfs_cid = result.cid;
        updateData.encrypted_content = null; // clear stale DB copy if any
      } else {
        updateData.encrypted_content = newEncryptedJson;
      }

      const { error: updateError } = await supabase
        .from('geo_drops')
        .update(updateData)
        .eq('id', dropId);
      if (updateError) throw updateError;
    },

    /**
     * Export encryption secrets as password-encrypted JSON for backup.
     */
    exportEncryptedSecrets: async (masterPassword: string) => {
      const secrets: Record<number, string> = {};
      for (const [v, s] of secretMap.entries()) secrets[v] = s;
      const payload = JSON.stringify({ secrets, currentVersion: currentSecretVersion });
      const encrypted = await encrypt(payload, masterPassword);
      return JSON.stringify(encrypted);
    },

    /**
     * Import encryption secrets from a backup blob.
     */
    importEncryptedSecrets: async (blob: string, masterPassword: string) => {
      const payload = JSON.parse(blob);
      const decrypted = await decrypt(payload, masterPassword);
      const data = JSON.parse(decrypted) as { secrets: Record<number, string> };
      return data.secrets;
    },

    // =====================
    // SBPP (Search-Bound Proximity Proofs)
    // =====================

    initSearchSession: (ttlMs?: number) => {
      return sbppSessionStore.issue({ ttlMs });
    },

    findNearbyDropsSbpp: async (
      lat: number,
      lon: number,
      radiusMeters: number = 1000,
      session: SbppSession,
    ): Promise<NearbyDrop[]> => {
      validateCoords(lat, lon);

      if (!sbppSearchConfig) {
        throw new Error('SBPP requires encryptedSearchConfig in GeoDropOptions');
      }

      // Generate encrypted search tokens (GridSE-style)
      const { searchTokens } = await sbppSearch(
        lat, lon, radiusMeters, session, sbppSearchConfig,
      );

      // Match against indexed drops
      // In production: send tokens to Edge Function for server-side matching.
      // Here: client-side matching against locally available index tokens.
      const { data: indexedDropsRaw, error } = await supabase
        .from('drop_index_tokens')
        .select('drop_id, tokens');

      if (error) throw error;

      const indexedDrops = (indexedDropsRaw ?? []).map((row: { drop_id: string; tokens: LocationIndexTokens }) => ({
        dropId: row.drop_id,
        tokens: row.tokens,
      }));

      const matches = sbppMatch(
        searchTokens, indexedDrops,
        sbppSessionStore, session.sessionId, session.nonce,
      );

      if (matches.length === 0) return [];

      // Fetch full drop data for matched IDs
      const matchedIds = matches.map(m => m.dropId);
      const { data: drops, error: dropError } = await supabase
        .from('geo_drops')
        .select('id,creator_id,title,content_type,visibility,geohash,lat,lon,unlock_radius_meters,status,claim_count,max_claims,expires_at,created_at,updated_at,ipfs_cid,proof_config')
        .eq('status', 'active')
        .in('id', matchedIds)
        .or('expires_at.is.null,expires_at.gt.now()');

      if (dropError) throw dropError;

      return (drops ?? [] as GeoDrop[])
        .map(d => {
          const drop = d as GeoDrop;
          const distance = calculateDistance(lat, lon, drop.lat, drop.lon);
          return { drop, distance_meters: Math.round(distance), can_unlock: distance <= drop.unlock_radius_meters };
        })
        .filter(n => n.distance_meters <= radiusMeters)
        .sort((a, b) => a.distance_meters - b.distance_meters);
    },

    // Utilities
    encodeGeohash,
    decodeGeohash,
    calculateDistance,
  };
}
