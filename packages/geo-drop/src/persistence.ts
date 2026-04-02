/**
 * Persistence manager
 * Manages IPFS storage, on-chain registration, and recovery of drop metadata
 */
import type {
  GeoDrop,
  PersistenceLevel,
  PersistenceResult,
  DropMetadataDocument,
  DropMetadataDocumentV2,
  RecoveredDrop,
} from './types';
import type { IpfsClient } from './ipfs';
import type { ChainClient } from './chain';
import { encrypt, decrypt, CURRENT_KEY_VERSION } from './crypto';

export interface PersistenceManager {
  /** Persist drop metadata */
  persist(drop: GeoDrop, level: PersistenceLevel, recoverySecret?: string): Promise<PersistenceResult>;
  /** Recover directly from a metadata CID */
  recoverFromCid(metadataCid: string, recoverySecret?: string): Promise<RecoveredDrop>;
  /** Search the on-chain index by geohash and recover */
  recoverFromChain(geohash: string): Promise<RecoveredDrop[]>;
}

/**
 * Create a persistence manager
 */
export interface PersistenceManagerConfig {
  /** Use V2 metadata format (default: true for new drops) */
  useV2Metadata?: boolean;
  /** Additional IPFS clients for redundant pinning */
  redundantPinners?: IpfsClient[];
  /** Pinning provider names for metadata tracking */
  pinningProviderNames?: string[];
}

export function createPersistenceManager(
  ipfs: IpfsClient,
  chain?: ChainClient,
  config?: PersistenceManagerConfig,
): PersistenceManager {
  const useV2 = config?.useV2Metadata ?? true;
  const redundantPinners = config?.redundantPinners ?? [];
  const providerNames = config?.pinningProviderNames ?? [];

  // =====================
  // Metadata document construction
  // =====================

  function buildMetadataDoc(drop: GeoDrop): DropMetadataDocument {
    if (!useV2) {
      // V1 backward compatibility
      return {
        version: 1,
        dropId: drop.id,
        geohash: drop.geohash,
        contentCid: drop.ipfs_cid ?? '',
        encryptionSalt: drop.encryption_salt ?? '',
        unlockRadiusMeters: drop.unlock_radius_meters,
        contentType: drop.content_type,
        title: drop.title,
        proofConfig: drop.proof_config,
        createdAt: drop.created_at,
      };
    }

    const doc: DropMetadataDocumentV2 = {
      version: 2,
      dropId: drop.id,
      geohash: drop.geohash,
      contentCid: drop.ipfs_cid ?? '',
      encryptionSalt: drop.encryption_salt ?? '',
      unlockRadiusMeters: drop.unlock_radius_meters,
      contentType: drop.content_type,
      title: drop.title,
      proofConfig: drop.proof_config,
      createdAt: drop.created_at,
      keyDerivationVersion: CURRENT_KEY_VERSION,
      encryptionAlgorithm: 'aes-256-gcm',
      pbkdf2Iterations: 100_000,
      pinningProviders: providerNames,
      serverSecretVersion: (drop as unknown as Record<string, unknown>).server_secret_version as number ?? 1,
    };
    return doc;
  }

  // =====================
  // Metadata encryption (for private/password drops)
  // =====================

  async function encryptMetadata(doc: DropMetadataDocument, secret: string): Promise<string> {
    const payload = await encrypt(JSON.stringify(doc), secret);
    // When encrypting, store minimal public info + encrypted payload
    // geohash is kept in plaintext as it is needed for on-chain search
    return JSON.stringify({
      version: 1,
      encrypted: true,
      geohash: doc.geohash,
      payload,
    });
  }

  async function decryptMetadata(raw: string, secret: string): Promise<DropMetadataDocument> {
    const wrapper = JSON.parse(raw) as { encrypted?: boolean; payload?: { ciphertext: string; iv: string; salt: string } };
    if (!wrapper.encrypted || !wrapper.payload) {
      return JSON.parse(raw) as DropMetadataDocument;
    }
    const decrypted = await decrypt(wrapper.payload, secret);
    return JSON.parse(decrypted) as DropMetadataDocument;
  }

  // =====================
  // Public API
  // =====================

  return {
    async persist(drop, level, recoverySecret?) {
      const result: PersistenceResult = { level };

      if (level === 'db-only') return result;

      // Build metadata document
      const doc = buildMetadataDoc(drop);
      let content: string;
      if (recoverySecret) {
        if (recoverySecret.length < 16) {
          throw new Error('Recovery secret too weak: minimum 16 characters required');
        }
        content = await encryptMetadata(doc, recoverySecret);
      } else {
        content = JSON.stringify(doc);
      }

      // Pin to primary IPFS provider
      const ipfsResult = await ipfs.upload(content);
      result.metadataCid = ipfsResult.cid;

      // Redundant pinning to additional providers (best-effort with logging)
      const pinResults: Array<{ provider: string; ok: boolean; error?: string }> = [];
      for (let i = 0; i < redundantPinners.length; i++) {
        const name = providerNames[i] ?? `pinner-${i}`;
        try {
          await redundantPinners[i].upload(content);
          pinResults.push({ provider: name, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          pinResults.push({ provider: name, ok: false, error: msg });
          console.warn(`[persistence] Redundant pin failed for ${name}: ${msg}`);
        }
      }
      result.pinResults = pinResults;

      // On-chain registration (use V2 if contract supports it)
      if (level === 'onchain' || level === 'ipfs+onchain') {
        if (!chain) throw new Error('Chain config required for on-chain persistence');
        const metadataVer = doc.version;
        try {
          // Try V2 registration first (includes metadata version)
          const { txHash, chainId: cid } = await chain.registerDropV2(
            drop.geohash, ipfsResult.cid, metadataVer
          );
          result.txHash = txHash;
          result.chainId = cid;
        } catch (v2Err) {
          // Fall back to V1 registration (for V1 contracts)
          const v2Msg = v2Err instanceof Error ? v2Err.message : String(v2Err);
          console.warn(
            `[persistence] V2 registration failed, falling back to V1. ` +
            `This means metadata version tracking is lost on-chain. ` +
            `Consider upgrading the contract to V2. Error: ${v2Msg}`
          );
          try {
            const { txHash, chainId: cid } = await chain.registerDrop(
              drop.geohash, ipfsResult.cid
            );
            result.txHash = txHash;
            result.chainId = cid;
            result.v2Fallback = true;
          } catch (v1Err) {
            const v1Msg = v1Err instanceof Error ? v1Err.message : String(v1Err);
            throw new Error(
              `On-chain registration failed for both V2 and V1. ` +
              `V2: ${v2Msg}. V1: ${v1Msg}. ` +
              `IPFS metadata was pinned (CID: ${ipfsResult.cid}) but NOT registered on-chain.`
            );
          }
        }
      }

      return result;
    },

    async recoverFromCid(metadataCid, recoverySecret?) {
      const raw = await ipfs.fetch(metadataCid);
      let metadata: DropMetadataDocument;

      if (recoverySecret) {
        metadata = await decryptMetadata(raw, recoverySecret);
      } else {
        const parsed = JSON.parse(raw);
        if (parsed.encrypted) {
          throw new Error('Metadata is encrypted. Provide recoverySecret to decrypt.');
        }
        metadata = parsed as DropMetadataDocument;
      }

      return { metadata, metadataCid, source: 'ipfs' as const };
    },

    async recoverFromChain(geohash) {
      if (!chain) throw new Error('Chain config required for on-chain recovery');
      const cids = await chain.getDropCids(geohash);
      const results: RecoveredDrop[] = [];

      for (const cid of cids) {
        try {
          const raw = await ipfs.fetch(cid);
          const parsed = JSON.parse(raw);
          if (parsed.encrypted) {
            // Encrypted metadata cannot be decrypted without the secret, but return existence info
            results.push({
              metadata: { ...parsed, dropId: '', contentCid: '', encryptionSalt: '', unlockRadiusMeters: 0, title: '', createdAt: '' },
              metadataCid: cid,
              source: 'onchain',
            });
          } else {
            results.push({
              metadata: parsed as DropMetadataDocument,
              metadataCid: cid,
              source: 'onchain',
            });
          }
        } catch {
          // Skip invalid CIDs or expired pins
          continue;
        }
      }

      return results;
    },
  };
}
