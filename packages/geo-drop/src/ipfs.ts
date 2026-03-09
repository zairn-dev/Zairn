/**
 * IPFS ストレージ
 * Pinata / web3.storage / カスタムゲートウェイに対応
 */
import type { IpfsConfig, IpfsUploadResult } from './types';

const DEFAULT_GATEWAY = 'https://w3s.link/ipfs';

export class IpfsClient {
  private gateway: string;
  private pinningService?: string;
  private pinningApiKey?: string;
  private pinningApiSecret?: string;
  private customPinningUrl?: string;

  constructor(config?: IpfsConfig) {
    this.gateway = config?.gateway ?? DEFAULT_GATEWAY;
    this.pinningService = config?.pinningService;
    this.pinningApiKey = config?.pinningApiKey;
    this.pinningApiSecret = config?.pinningApiSecret;
    this.customPinningUrl = config?.customPinningUrl;
  }

  /**
   * コンテンツをIPFSにアップロード
   */
  async upload(content: File | Blob | string): Promise<IpfsUploadResult> {
    const blob = typeof content === 'string'
      ? new Blob([content], { type: 'text/plain' })
      : content;

    switch (this.pinningService) {
      case 'pinata':
        return this.uploadToPinata(blob);
      case 'web3storage':
        return this.uploadToWeb3Storage(blob);
      case 'custom':
        return this.uploadToCustom(blob);
      default:
        // Pinata がデフォルト（APIキーがあれば）
        if (this.pinningApiKey) {
          return this.uploadToPinata(blob);
        }
        throw new Error('No IPFS pinning service configured. Set ipfs.pinningService and ipfs.pinningApiKey.');
    }
  }

  /**
   * IPFSからコンテンツを取得
   */
  async fetch(cid: string): Promise<string> {
    const url = `${this.gateway}/${cid}`;
    const response = await globalThis.fetch(url);
    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  /**
   * CIDからゲートウェイURLを生成
   */
  getUrl(cid: string): string {
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
      // Legacy API key pair
      headers['pinata_api_key'] = this.pinningApiKey;
      headers['pinata_secret_api_key'] = this.pinningApiSecret;
    } else {
      // JWT
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
      headers: {
        'Authorization': `Bearer ${this.pinningApiKey}`,
      },
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
  // カスタム
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
