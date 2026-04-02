/**
 * IPFS storage
 * Supports Pinata / web3.storage / custom gateways
 * Features: upload size limit, gateway failover with retry, streaming fetch
 */
import type { IpfsConfig, IpfsUploadResult } from './types';

// Base58btc alphabet (used by IPFS CIDv0)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's = leading zero bytes
  for (const char of str) { if (char !== '1') break; bytes.push(0); }
  return new Uint8Array(bytes.reverse());
}

const DEFAULT_GATEWAY = 'https://w3s.link/ipfs';
const MAX_FETCH_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

export class IpfsClient {
  private gateway: string;
  private fallbackGateways: string[];
  private pinningService?: string;
  private pinningApiKey?: string;
  private pinningApiSecret?: string;
  private customPinningUrl?: string;
  private maxUploadSize: number;

  constructor(config?: IpfsConfig) {
    this.gateway = config?.gateway ?? DEFAULT_GATEWAY;
    this.fallbackGateways = config?.fallbackGateways ?? [];
    this.pinningService = config?.pinningService;
    this.pinningApiKey = config?.pinningApiKey;
    this.pinningApiSecret = config?.pinningApiSecret;
    this.customPinningUrl = config?.customPinningUrl;
    this.maxUploadSize = config?.maxUploadSize ?? MAX_UPLOAD_SIZE;
  }

  /**
   * Upload content to IPFS (with size enforcement)
   */
  async upload(content: File | Blob | string): Promise<IpfsUploadResult> {
    const blob = typeof content === 'string'
      ? new Blob([content], { type: 'text/plain' })
      : content;

    // Enforce upload size limit
    if (blob.size > this.maxUploadSize) {
      throw new Error(
        `Upload too large: ${blob.size} bytes (max ${this.maxUploadSize})`
      );
    }

    switch (this.pinningService) {
      case 'pinata':
        return this.uploadToPinata(blob);
      case 'web3storage':
        return this.uploadToWeb3Storage(blob);
      case 'custom':
        return this.uploadToCustom(blob);
      default:
        if (this.pinningApiKey) {
          return this.uploadToPinata(blob);
        }
        throw new Error('No IPFS pinning service configured.');
    }
  }

  /**
   * Fetch content from IPFS with gateway failover, streaming size limit,
   * and content integrity verification for CIDv0 (Qm...) hashes.
   */
  async fetch(cid: string, options?: { skipIntegrityCheck?: boolean }): Promise<string> {
    if (!CID_RE.test(cid)) throw new Error(`Invalid IPFS CID: ${cid}`);

    const gateways = [this.gateway, ...this.fallbackGateways];
    let lastError: Error | null = null;

    for (const gw of gateways) {
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const content = await this.fetchFromGateway(gw, cid);

          // Verify content integrity for CIDv0 (SHA-256 based)
          if (!options?.skipIntegrityCheck && cid.startsWith('Qm') && typeof globalThis.crypto?.subtle !== 'undefined') {
            const verified = await this.verifyCidV0(cid, content);
            if (!verified) {
              throw new Error(
                `IPFS content integrity check failed for ${cid}. ` +
                `The content hash does not match the CID. ` +
                `This may indicate gateway corruption or a malicious gateway.`
              );
            }
          }

          return content;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Don't retry size-limit or integrity errors
          if (lastError.message.includes('too large') || lastError.message.includes('integrity')) throw lastError;
          // Wait before retry (skip delay on last attempt)
          if (attempt < RETRY_DELAYS.length) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          }
        }
      }
    }

    throw lastError ?? new Error(`IPFS fetch failed for ${cid}`);
  }

  /**
   * Verify a CIDv0 (Qm...) matches the SHA-256 hash of content.
   * CIDv0 = Base58btc(0x12 0x20 <sha256-hash>)
   */
  private async verifyCidV0(cid: string, content: string): Promise<boolean> {
    try {
      // Decode base58btc
      const decoded = base58Decode(cid);
      // CIDv0 format: 0x12 (sha2-256) 0x20 (32 bytes) <hash>
      if (decoded.length !== 34 || decoded[0] !== 0x12 || decoded[1] !== 0x20) {
        return true; // Not a standard CIDv0 sha2-256, skip verification
      }
      const expectedHash = decoded.slice(2);

      // Hash the content
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
      const actualHash = new Uint8Array(hashBuffer);

      // Compare
      if (actualHash.length !== expectedHash.length) return false;
      for (let i = 0; i < actualHash.length; i++) {
        if (actualHash[i] !== expectedHash[i]) return false;
      }
      return true;
    } catch {
      return true; // On error, don't block (best-effort verification)
    }
  }

  /**
   * Fetch from a single gateway with streaming size enforcement
   */
  private async fetchFromGateway(gateway: string, cid: string): Promise<string> {
    const url = `${gateway}/${cid}`;
    const response = await globalThis.fetch(url);
    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
    }

    // Check content-length header first
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_SIZE) {
      throw new Error(`IPFS content too large: ${contentLength} bytes (max ${MAX_FETCH_SIZE})`);
    }

    // Streaming read with byte limit (handles chunked responses)
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_FETCH_SIZE) {
          reader.cancel();
          throw new Error(`IPFS content too large: ${totalBytes}+ bytes (max ${MAX_FETCH_SIZE})`);
        }
        chunks.push(value);
      }

      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(combined);
    }

    // Fallback for environments without ReadableStream
    const text = await response.text();
    if (text.length > MAX_FETCH_SIZE) {
      throw new Error(`IPFS content too large: ${text.length} bytes (max ${MAX_FETCH_SIZE})`);
    }
    return text;
  }

  getUrl(cid: string): string {
    if (!CID_RE.test(cid)) throw new Error(`Invalid IPFS CID: ${cid}`);
    return `${this.gateway}/${cid}`;
  }

  // =====================
  // Pinata
  // =====================
  private async uploadToPinata(blob: Blob): Promise<IpfsUploadResult> {
    if (!this.pinningApiKey) throw new Error('Pinata API key is required');

    const formData = new FormData();
    formData.append('file', blob);

    const headers: Record<string, string> = {};
    if (this.pinningApiSecret) {
      headers['pinata_api_key'] = this.pinningApiKey;
      headers['pinata_secret_api_key'] = this.pinningApiSecret;
    } else {
      headers['Authorization'] = `Bearer ${this.pinningApiKey}`;
    }

    const response = await globalThis.fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Pinata upload failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { IpfsHash: string; PinSize: number };
    return {
      cid: result.IpfsHash,
      size: result.PinSize,
      url: this.getUrl(result.IpfsHash),
    };
  }

  // =====================
  // web3.storage
  // =====================
  private async uploadToWeb3Storage(blob: Blob): Promise<IpfsUploadResult> {
    if (!this.pinningApiKey) throw new Error('web3.storage API token is required');

    const response = await globalThis.fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.pinningApiKey}` },
      body: blob,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`web3.storage upload failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { cid: string };
    return {
      cid: result.cid,
      size: blob.size,
      url: this.getUrl(result.cid),
    };
  }

  // =====================
  // Custom
  // =====================
  private async uploadToCustom(blob: Blob): Promise<IpfsUploadResult> {
    if (!this.customPinningUrl) throw new Error('Custom pinning URL is required');

    const formData = new FormData();
    formData.append('file', blob);

    const headers: Record<string, string> = {};
    if (this.pinningApiKey) {
      headers['Authorization'] = `Bearer ${this.pinningApiKey}`;
    }

    const response = await globalThis.fetch(this.customPinningUrl, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Custom IPFS upload failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { cid?: string; Hash?: string; size?: number };
    const cid = result.cid ?? result.Hash;
    if (!cid) throw new Error('No CID returned from custom pinning service');

    return {
      cid,
      size: result.size ?? blob.size,
      url: this.getUrl(cid),
    };
  }
}
