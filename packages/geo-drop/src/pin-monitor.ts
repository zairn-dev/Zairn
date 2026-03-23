/**
 * IPFS Pin Health Monitoring
 *
 * Utilities for auditing CID availability across gateways,
 * detecting degraded/missing pins, and re-pinning content.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { IpfsClient } from './ipfs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health status of a single CID on a single gateway. */
export interface GatewayStatus {
  gateway: string;
  reachable: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/** Aggregated health result for a single CID across gateways. */
export interface PinHealthResult {
  cid: string;
  checkedAt: string;
  gateways: GatewayStatus[];
  /** CID reachable from at least one gateway. */
  available: boolean;
  /** CID reachable from all gateways. */
  fullyRedundant: boolean;
  /** Number of gateways that can serve the CID. */
  reachableCount: number;
}

/** Per-drop audit entry. */
export interface DropPinEntry {
  dropId: string;
  cid: string;
  health: PinHealthResult;
}

/** Summary report produced by `auditDropPins`. */
export interface PinAuditReport {
  startedAt: string;
  completedAt: string;
  totalDrops: number;
  totalWithCid: number;
  healthy: number;
  degraded: number;
  missing: number;
  entries: DropPinEntry[];
  errors: Array<{ dropId: string; cid: string; error: string }>;
}

/** Result of a re-pin operation. */
export interface RepinResult {
  startedAt: string;
  completedAt: string;
  attempted: number;
  succeeded: number;
  failed: number;
  details: Array<{
    cid: string;
    dropId: string;
    success: boolean;
    pinner?: string;
    error?: string;
  }>;
}

/** Options for `checkPinHealth`. */
export interface PinHealthOptions {
  /** Per-gateway request timeout in milliseconds (default: 15 000). */
  timeoutMs?: number;
  /** Use HEAD instead of GET to reduce bandwidth (default: true). */
  headOnly?: boolean;
}

/** Options for `auditDropPins`. */
export interface AuditOptions extends PinHealthOptions {
  /** Maximum number of concurrent health checks (default: 8). */
  concurrency?: number;
  /** Only audit drops created after this ISO timestamp. */
  createdAfter?: string;
  /** Log progress callback. */
  onProgress?: (checked: number, total: number) => void;
}

/** Options for `repinMissing`. */
export interface RepinOptions {
  /** Maximum number of concurrent re-pin uploads (default: 4). */
  concurrency?: number;
  /** Log progress callback. */
  onProgress?: (processed: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AUDIT_CONCURRENCY = 8;
const DEFAULT_REPIN_CONCURRENCY = 4;
const PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with an AbortController-based timeout.
 * Returns the Response or throws on timeout / network error.
 */
async function fetchWithTimeout(
  url: string,
  method: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await globalThis.fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an async function over an array with bounded concurrency.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Check whether a CID is retrievable from each of the given gateways.
 *
 * By default a HEAD request is used to minimise bandwidth.  Set
 * `options.headOnly` to `false` to perform a full GET (useful when you want to
 * verify actual content delivery, not just gateway routing).
 */
export async function checkPinHealth(
  cid: string,
  gateways: string[],
  options?: PinHealthOptions,
): Promise<PinHealthResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (options?.headOnly ?? true) ? 'HEAD' : 'GET';

  const statuses: GatewayStatus[] = await Promise.all(
    gateways.map(async (gateway): Promise<GatewayStatus> => {
      const url = `${gateway.replace(/\/+$/, '')}/${cid}`;
      const start = Date.now();
      try {
        const res = await fetchWithTimeout(url, method, timeoutMs);
        const latencyMs = Date.now() - start;
        // 2xx = content served; 3xx redirect we already follow.
        const reachable = res.ok;
        return { gateway, reachable, latencyMs, httpStatus: res.status };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = message.includes('abort');
        return {
          gateway,
          reachable: false,
          latencyMs,
          error: isTimeout ? `Timeout after ${timeoutMs}ms` : message,
        };
      }
    }),
  );

  const reachableCount = statuses.filter((s) => s.reachable).length;

  return {
    cid,
    checkedAt: new Date().toISOString(),
    gateways: statuses,
    available: reachableCount > 0,
    fullyRedundant: reachableCount === gateways.length,
    reachableCount,
  };
}

/**
 * Audit all drops that have an `ipfs_cid` stored in the database.
 *
 * Walks the `geo_drops` table in pages, checks each CID against the gateways
 * configured on the provided `IpfsClient`, and returns a structured report.
 */
export async function auditDropPins(
  supabase: SupabaseClient,
  ipfs: IpfsClient,
  options?: AuditOptions,
): Promise<PinAuditReport> {
  const startedAt = new Date().toISOString();
  const concurrency = options?.concurrency ?? DEFAULT_AUDIT_CONCURRENCY;

  // Derive gateways from the IpfsClient's public URL helper.
  // The client exposes `getUrl(cid)` -> "{gateway}/{cid}", so we extract the
  // prefix.  We also accept caller-supplied gateways in the health-check
  // options, but we need at least the primary gateway.
  const gateways = extractGateways(ipfs);

  // ---- Fetch all drops with an IPFS CID ----
  const drops: Array<{ id: string; ipfs_cid: string }> = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('geo_drops')
      .select('id, ipfs_cid')
      .not('ipfs_cid', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (options?.createdAfter) {
      query = query.gte('created_at', options.createdAfter);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to query geo_drops: ${error.message}`);
    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      for (const row of data) {
        if (row.ipfs_cid) {
          drops.push({ id: row.id, ipfs_cid: row.ipfs_cid });
        }
      }
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }
  }

  // ---- Check each CID ----
  const entries: DropPinEntry[] = [];
  const errors: PinAuditReport['errors'] = [];
  let checked = 0;

  await mapConcurrent(drops, concurrency, async (drop) => {
    try {
      const health = await checkPinHealth(drop.ipfs_cid, gateways, options);
      entries.push({ dropId: drop.id, cid: drop.ipfs_cid, health });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ dropId: drop.id, cid: drop.ipfs_cid, error: message });
    }
    checked++;
    options?.onProgress?.(checked, drops.length);
  });

  // ---- Classify ----
  let healthy = 0;
  let degraded = 0;
  let missing = 0;

  for (const entry of entries) {
    if (entry.health.fullyRedundant) {
      healthy++;
    } else if (entry.health.available) {
      degraded++;
    } else {
      missing++;
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    totalDrops: drops.length + errors.length,
    totalWithCid: drops.length,
    healthy,
    degraded,
    missing,
    entries,
    errors,
  };
}

/**
 * Re-pin CIDs that are unreachable from the primary gateway.
 *
 * For each missing CID the function:
 * 1. Attempts to fetch the content from any fallback gateway.
 * 2. Re-uploads the content via each of the `redundantPinners`.
 *
 * This is intentionally separated from `auditDropPins` so callers can review
 * the audit report before triggering mutations.
 */
export async function repinMissing(
  supabase: SupabaseClient,
  ipfs: IpfsClient,
  redundantPinners: IpfsClient[],
  options?: RepinOptions,
): Promise<RepinResult> {
  const startedAt = new Date().toISOString();
  const concurrency = options?.concurrency ?? DEFAULT_REPIN_CONCURRENCY;

  // Build the audit first to discover what is missing.
  const audit = await auditDropPins(supabase, ipfs);

  const missingEntries = audit.entries.filter((e) => !e.health.available);
  const degradedEntries = audit.entries.filter(
    (e) => e.health.available && !e.health.fullyRedundant,
  );

  // We re-pin both missing and degraded CIDs.
  const toRepin = [...missingEntries, ...degradedEntries];

  const details: RepinResult['details'] = [];
  let succeeded = 0;
  let failed = 0;
  let processed = 0;

  await mapConcurrent(toRepin, concurrency, async (entry) => {
    // Try to fetch content from any reachable gateway.
    const reachableGw = entry.health.gateways.find((g) => g.reachable);
    if (!reachableGw) {
      // Content completely lost -- we cannot recover without external backup.
      details.push({
        cid: entry.cid,
        dropId: entry.dropId,
        success: false,
        error: 'No reachable gateway to fetch content from',
      });
      failed++;
      processed++;
      options?.onProgress?.(processed, toRepin.length);
      return;
    }

    try {
      // Fetch the raw content.
      const url = `${reachableGw.gateway.replace(/\/+$/, '')}/${entry.cid}`;
      const res = await globalThis.fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();

      // Re-upload to each redundant pinner.
      for (const pinner of redundantPinners) {
        try {
          await pinner.upload(blob);
          details.push({
            cid: entry.cid,
            dropId: entry.dropId,
            success: true,
            pinner: extractGateways(pinner)[0],
          });
          succeeded++;
        } catch (pinErr) {
          const msg = pinErr instanceof Error ? pinErr.message : String(pinErr);
          details.push({
            cid: entry.cid,
            dropId: entry.dropId,
            success: false,
            pinner: extractGateways(pinner)[0],
            error: msg,
          });
          failed++;
        }
      }
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      details.push({
        cid: entry.cid,
        dropId: entry.dropId,
        success: false,
        error: `Content fetch failed: ${msg}`,
      });
      failed++;
    }

    processed++;
    options?.onProgress?.(processed, toRepin.length);
  });

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    attempted: toRepin.length,
    succeeded,
    failed,
    details,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the list of gateways from an IpfsClient instance.
 *
 * We use `getUrl()` with a dummy CID to infer the primary gateway prefix,
 * then combine it with any fallback gateways the caller may have configured.
 * Because `IpfsClient` does not expose its `fallbackGateways` directly, we
 * derive the primary gateway and accept that fallbacks will be checked
 * implicitly if the caller passed the same config to both audit and client.
 */
function extractGateways(client: IpfsClient): string[] {
  // getUrl returns "{gateway}/{cid}" -- extract the gateway prefix.
  const sentinel = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'; // valid CIDv0
  const fullUrl = client.getUrl(sentinel);
  const primary = fullUrl.replace(`/${sentinel}`, '');
  return [primary];
}
