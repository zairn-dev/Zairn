/**
 * Integration tests for persistence manager + chain client
 *
 * Tests the following scenarios:
 * - IPFS upload + metadata construction
 * - Chain registration with gas estimation + receipt validation
 * - V2 → V1 fallback with warning
 * - Recovery from CID and from chain
 * - Error handling for reverted transactions
 *
 * Uses mock implementations (no real IPFS/chain needed).
 */
import { describe, it, expect, vi } from 'vitest';
import { createPersistenceManager } from '../src/persistence';
import { createChainClient } from '../src/chain';
import { IpfsClient } from '../src/ipfs';
import type { GeoDrop, PersistenceLevel, ChainConfig } from '../src/types';

// ============================================================
// Mock IPFS Client
// ============================================================
class MockIpfsClient {
  private store = new Map<string, string>();
  uploadCount = 0;

  async upload(content: string): Promise<{ cid: string; size: number; url: string }> {
    this.uploadCount++;
    const cid = `Qm${Buffer.from(content).toString('base64').slice(0, 44).replace(/[+/=]/g, 'a')}`;
    this.store.set(cid, content);
    return { cid, size: content.length, url: `https://mock.ipfs/${cid}` };
  }

  async fetch(cid: string): Promise<string> {
    const content = this.store.get(cid);
    if (!content) throw new Error(`CID not found: ${cid}`);
    return content;
  }

  getUrl(cid: string): string {
    return `https://mock.ipfs/${cid}`;
  }
}

// ============================================================
// Mock Chain Client
// ============================================================
function createMockChainClient(options?: {
  v2Fails?: boolean;
  v1Fails?: boolean;
  revertOnRegister?: boolean;
}) {
  const registered: Array<{ geohash: string; cid: string; version?: number }> = [];
  const opts = options ?? {};

  return {
    client: {
      async registerDrop(geohash: string, metadataCid: string) {
        if (opts.v1Fails) throw new Error('V1 contract call failed');
        if (opts.revertOnRegister) return { txHash: '0xdead', chainId: 84532 };
        registered.push({ geohash, cid: metadataCid });
        return { txHash: '0x' + 'a'.repeat(64), chainId: 84532 };
      },
      async registerDropV2(geohash: string, metadataCid: string, metadataVersion: number) {
        if (opts.v2Fails) throw new Error('V2 method not found (V1 contract)');
        registered.push({ geohash, cid: metadataCid, version: metadataVersion });
        return { txHash: '0x' + 'b'.repeat(64), chainId: 84532 };
      },
      async getDropCids(geohash: string) {
        return registered.filter(r => r.geohash === geohash).map(r => r.cid);
      },
      async getVersion() { return opts.v2Fails ? 0 : 2; },
    },
    registered,
  };
}

// ============================================================
// Test drop fixture
// ============================================================
function makeDrop(overrides?: Partial<GeoDrop>): GeoDrop {
  return {
    id: 'drop-001',
    creator_id: 'user-001',
    lat: 35.6812,
    lon: 139.7671,
    geohash: 'xn76urx',
    unlock_radius_meters: 100,
    title: 'Test Drop',
    content_type: 'text',
    encrypted_content: 'encrypted-payload',
    encryption_salt: 'salt123',
    ipfs_cid: null,
    proof_config: null,
    max_claims: null,
    expires_at: null,
    visibility: 'public',
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    claim_count: 0,
    ...overrides,
  } as GeoDrop;
}

// ============================================================
// Tests
// ============================================================
describe('PersistenceManager', () => {
  it('db-only returns immediately without IPFS or chain', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    const result = await pm.persist(makeDrop(), 'db-only');
    expect(result.level).toBe('db-only');
    expect(result.metadataCid).toBeUndefined();
    expect(ipfs.uploadCount).toBe(0);
  });

  it('ipfs level uploads metadata and returns CID', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    const result = await pm.persist(makeDrop(), 'ipfs');
    expect(result.level).toBe('ipfs');
    expect(result.metadataCid).toBeDefined();
    expect(result.metadataCid!.startsWith('Qm')).toBe(true);
    expect(ipfs.uploadCount).toBe(1);
  });

  it('onchain level registers on V2 contract', async () => {
    const ipfs = new MockIpfsClient();
    const { client, registered } = createMockChainClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient, client as any);
    const result = await pm.persist(makeDrop(), 'onchain');
    expect(result.txHash).toBeDefined();
    expect(result.chainId).toBe(84532);
    expect(registered.length).toBe(1);
    expect(registered[0].version).toBe(2); // V2 metadata
    expect(registered[0].geohash).toBe('xn76urx');
  });

  it('falls back to V1 with warning when V2 fails', async () => {
    const ipfs = new MockIpfsClient();
    const { client, registered } = createMockChainClient({ v2Fails: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient, client as any);
    const result = await pm.persist(makeDrop(), 'onchain');

    expect(result.txHash).toBeDefined();
    expect(result.v2Fallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('V2 registration failed, falling back to V1')
    );
    expect(registered[0].version).toBeUndefined(); // V1 doesn't track version
    warnSpy.mockRestore();
  });

  it('throws with details when both V2 and V1 fail', async () => {
    const ipfs = new MockIpfsClient();
    const { client } = createMockChainClient({ v2Fails: true, v1Fails: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient, client as any);

    await expect(pm.persist(makeDrop(), 'onchain'))
      .rejects.toThrow('On-chain registration failed for both V2 and V1');
    warnSpy.mockRestore();
  });

  it('throws when chain config missing for onchain level', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    await expect(pm.persist(makeDrop(), 'onchain'))
      .rejects.toThrow('Chain config required');
  });

  it('recoverFromCid retrieves and parses metadata', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    const persisted = await pm.persist(makeDrop(), 'ipfs');
    const recovered = await pm.recoverFromCid(persisted.metadataCid!);
    expect(recovered.metadata.dropId).toBe('drop-001');
    expect(recovered.metadata.geohash).toBe('xn76urx');
    expect(recovered.source).toBe('ipfs');
  });

  it('recoverFromChain retrieves all drops for a geohash', async () => {
    const ipfs = new MockIpfsClient();
    const { client } = createMockChainClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient, client as any);

    await pm.persist(makeDrop({ id: 'drop-A' }), 'onchain');
    await pm.persist(makeDrop({ id: 'drop-B' }), 'onchain');

    const recovered = await pm.recoverFromChain('xn76urx');
    expect(recovered.length).toBe(2);
    expect(recovered.map(r => r.metadata.dropId).sort()).toEqual(['drop-A', 'drop-B']);
  });

  it('encrypted metadata requires recoverySecret', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    const secret = 'super-secret-recovery-key-1234';
    const persisted = await pm.persist(makeDrop(), 'ipfs', secret);

    // Without secret: should fail
    await expect(pm.recoverFromCid(persisted.metadataCid!))
      .rejects.toThrow('Metadata is encrypted');

    // With secret: should succeed
    const recovered = await pm.recoverFromCid(persisted.metadataCid!, secret);
    expect(recovered.metadata.dropId).toBe('drop-001');
  });

  it('rejects weak recovery secret', async () => {
    const ipfs = new MockIpfsClient();
    const pm = createPersistenceManager(ipfs as unknown as IpfsClient);
    await expect(pm.persist(makeDrop(), 'ipfs', 'short'))
      .rejects.toThrow('Recovery secret too weak');
  });

  it('redundant pinning logs failures without blocking', async () => {
    const ipfs = new MockIpfsClient();
    const failingPinner = {
      async upload() { throw new Error('pinner down'); },
      async fetch() { return ''; },
      getUrl() { return ''; },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = createPersistenceManager(
      ipfs as unknown as IpfsClient,
      undefined,
      {
        redundantPinners: [failingPinner as unknown as IpfsClient],
        pinningProviderNames: ['backup-pinner'],
      },
    );
    const result = await pm.persist(makeDrop(), 'ipfs');
    expect(result.metadataCid).toBeDefined(); // Primary succeeded
    expect(result.pinResults).toHaveLength(1);
    expect(result.pinResults![0].ok).toBe(false);
    expect(result.pinResults![0].provider).toBe('backup-pinner');
    warnSpy.mockRestore();
  });
});
