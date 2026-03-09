/**
 * Persistence manager
 * Manages IPFS storage, on-chain registration, and recovery of drop metadata
 */
import type {
  GeoDrop,
  PersistenceLevel,
  PersistenceResult,
  DropMetadataDocument,
  RecoveredDrop,
} from './types';
import type { IpfsClient } from './ipfs';
import type { ChainClient } from './chain';
import { encrypt, decrypt } from './crypto';

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
export function createPersistenceManager(
  ipfs: IpfsClient,
  chain?: ChainClient
): PersistenceManager {

  // =====================
  // Metadata document construction
  // =====================

  function buildMetadataDoc(drop: GeoDrop): DropMetadataDocument {
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
        content = await encryptMetadata(doc, recoverySecret);
      } else {
        content = JSON.stringify(doc);
      }

      // Pin to IPFS (also required implicitly for onchain)
      const ipfsResult = await ipfs.upload(content);
      result.metadataCid = ipfsResult.cid;

      // On-chain registration
      if (level === 'onchain' || level === 'ipfs+onchain') {
        if (!chain) throw new Error('Chain config required for on-chain persistence');
        const { txHash, chainId } = await chain.registerDrop(drop.geohash, ipfsResult.cid);
        result.txHash = txHash;
        result.chainId = chainId;
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
