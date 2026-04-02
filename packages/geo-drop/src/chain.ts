/**
 * EVM chain client
 * Handles communication with the GeoDropRegistry contract
 * No external dependencies (raw JSON-RPC + manual ABI encoding)
 */
import type { ChainConfig, EvmSigner } from './types';

// GeoDropRegistry function selectors (first 4 bytes of keccak256)
const SELECTOR_REGISTER = '0xd0495692'; // registerDrop(bytes7,string)
const SELECTOR_REGISTER_V2 = '0x8c4e4b18'; // registerDropV2(bytes7,string,uint8)
const SELECTOR_GET_CIDS = '0x586938e6'; // getDropCids(bytes7)
const SELECTOR_VERSION = '0x54fd4d50'; // version()

export interface ChainClient {
  /** Register a drop's metadata CID on-chain (V1 compatible) */
  registerDrop(geohash: string, metadataCid: string): Promise<{ txHash: string; chainId?: number }>;
  /** Register with metadata version (V2 contract) */
  registerDropV2(geohash: string, metadataCid: string, metadataVersion: number): Promise<{ txHash: string; chainId?: number }>;
  /** Get all metadata CIDs registered for a geohash (no gas required) */
  getDropCids(geohash: string): Promise<string[]>;
  /** Check contract version (returns 0 for V1, 2 for V2) */
  getVersion(): Promise<number>;
}

/**
 * Create a chain client
 */
export function createChainClient(config: ChainConfig): ChainClient {
  const { rpcUrl, registryAddress, signer, chainId } = config;

  // =====================
  // ABI encoding helpers
  // =====================

  function encodeBytes7Param(geohash: string): string {
    // ABI encoding: bytes7 is left-aligned, right-padded in a 32-byte slot
    // Normalize geohash to 7 characters (right-pad with 0 if shorter)
    const normalized = geohash.substring(0, 7).padEnd(7, '0');
    const hex = Array.from(normalized)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    return hex.padEnd(64, '0');
  }

  function encodeStringParam(str: string, offset: number): { offsetHex: string; dataContent: string } {
    if (!/^[\x00-\x7f]*$/.test(str)) throw new Error('ABI string encoding only supports ASCII');
    // ABI encoding: dynamic string
    // offset pointer (32 bytes)
    const offsetHex = offset.toString(16).padStart(64, '0');
    // length (32 bytes)
    const length = str.length;
    const lengthHex = length.toString(16).padStart(64, '0');
    // data (padded to 32-byte boundary)
    const dataHex = Array.from(str)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    const paddedData = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, '0');
    return { offsetHex, dataContent: lengthHex + paddedData };
  }

  function encodeRegisterDrop(geohash: string, metadataCid: string): string {
    // registerDrop(bytes7 geohash, string metadataCid)
    const geohashSlot = encodeBytes7Param(geohash);
    // string offset = 0x40 (2 * 32 bytes from start of params)
    const strEnc = encodeStringParam(metadataCid, 0x40);
    return SELECTOR_REGISTER + geohashSlot + strEnc.offsetHex + strEnc.dataContent;
  }

  function encodeGetDropCids(geohash: string): string {
    // getDropCids(bytes7 geohash)
    const geohashSlot = encodeBytes7Param(geohash);
    return SELECTOR_GET_CIDS + geohashSlot;
  }

  // =====================
  // ABI decoding helpers
  // =====================

  function decodeStringArray(hex: string): string[] {
    // ABI decoding: response from a view function returning string[]
    // Remove 0x prefix
    const data = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (data.length < 128) return [];

    // First 32 bytes: offset to array data
    const arrayOffset = parseInt(data.slice(0, 64), 16) * 2;
    // Array length
    const arrayLength = parseInt(data.slice(arrayOffset, arrayOffset + 64), 16);
    if (arrayLength === 0) return [];

    const results: string[] = [];

    // Offset table for each element
    const offsetsStart = arrayOffset + 64;
    for (let i = 0; i < arrayLength; i++) {
      const elemOffsetHex = data.slice(offsetsStart + i * 64, offsetsStart + (i + 1) * 64);
      const elemOffset = parseInt(elemOffsetHex, 16) * 2 + arrayOffset + 64;
      // String length
      const strLength = parseInt(data.slice(elemOffset, elemOffset + 64), 16);
      // String data
      const strHex = data.slice(elemOffset + 64, elemOffset + 64 + strLength * 2);
      let str = '';
      for (let j = 0; j < strHex.length; j += 2) {
        str += String.fromCharCode(parseInt(strHex.slice(j, j + 2), 16));
      }
      results.push(str);
    }

    return results;
  }

  // =====================
  // JSON-RPC communication
  // =====================

  async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC request failed: ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }

  async function ethCall(data: string): Promise<string> {
    return await rpcCall('eth_call', [{ to: registryAddress, data }, 'latest']) as string;
  }

  // =====================
  // Public API
  // =====================

  function encodeRegisterDropV2(geohash: string, metadataCid: string, metadataVer: number): string {
    // ABI: registerDropV2(bytes7 geohash7, string metadataCid, uint8 metadataVer)
    // Slot 0: bytes7 geohash (static, left-aligned)
    // Slot 1: offset to string data (dynamic) = 0x60 (3 * 32 bytes)
    // Slot 2: uint8 metadataVer (static)
    // Then: string length + padded data at offset 0x60
    const geohashSlot = encodeBytes7Param(geohash);
    const strEnc = encodeStringParam(metadataCid, 0x60);
    const verSlot = metadataVer.toString(16).padStart(64, '0');
    return SELECTOR_REGISTER_V2 + geohashSlot + strEnc.offsetHex + verSlot + strEnc.dataContent;
  }

  return {
    async registerDrop(geohash: string, metadataCid: string) {
      if (!signer) throw new Error('Signer required for on-chain registration');

      const data = encodeRegisterDrop(geohash, metadataCid);
      const from = await signer.getAddress();

      // Estimate gas before sending (prevents wasted tx fees on revert)
      const gasEstimate = await rpcCall('eth_estimateGas', [{
        from, to: registryAddress, data,
      }]) as string;

      const tx = await signer.sendTransaction({
        to: registryAddress,
        data,
      });
      const receipt = await tx.wait(config.confirmations ?? 2);

      // Verify transaction succeeded (status 0 = revert)
      if (receipt.status === 0) {
        throw new Error(
          `On-chain registerDrop reverted (tx: ${tx.hash}). ` +
          `This may indicate a duplicate geohash registration or contract error.`
        );
      }

      return { txHash: tx.hash, chainId, gasUsed: gasEstimate };
    },

    async registerDropV2(geohash: string, metadataCid: string, metadataVersion: number) {
      if (!signer) throw new Error('Signer required for on-chain registration');

      const data = encodeRegisterDropV2(geohash, metadataCid, metadataVersion);
      const from = await signer.getAddress();

      // Estimate gas before sending
      const gasEstimate = await rpcCall('eth_estimateGas', [{
        from, to: registryAddress, data,
      }]) as string;

      const tx = await signer.sendTransaction({
        to: registryAddress,
        data,
      });
      const receipt = await tx.wait(config.confirmations ?? 2);

      if (receipt.status === 0) {
        throw new Error(
          `On-chain registerDropV2 reverted (tx: ${tx.hash}). ` +
          `Check rate-limit cooldown (10s) or contract state.`
        );
      }

      return { txHash: tx.hash, chainId, gasUsed: gasEstimate };
    },

    async getDropCids(geohash: string) {
      const data = encodeGetDropCids(geohash);
      const result = await ethCall(data);
      return decodeStringArray(result);
    },

    async getVersion() {
      try {
        const result = await ethCall(SELECTOR_VERSION + '0'.repeat(64));
        return parseInt(result.slice(2, 66), 16);
      } catch {
        return 0; // V1 contract doesn't have version()
      }
    },
  };
}
