#!/usr/bin/env node
/**
 * audit-pins.mjs -- Standalone IPFS pin health auditor
 *
 * Designed to run as a cron job.  Reads configuration from environment
 * variables, audits every geo_drop with an ipfs_cid, and prints a
 * JSON report to stdout.  Exits with code 1 when missing pins are
 * detected so cron / CI runners can alert on failure.
 *
 * Required env vars:
 *   SUPABASE_URL          - Project URL
 *   SUPABASE_SERVICE_KEY  - Service-role key (bypasses RLS for audit)
 *
 * Optional env vars:
 *   IPFS_GATEWAY          - Primary IPFS gateway   (default: https://w3s.link/ipfs)
 *   IPFS_FALLBACK_GATEWAYS- Comma-separated fallback gateways
 *   IPFS_PINNING_SERVICE  - pinata | web3storage | custom
 *   IPFS_PINNING_API_KEY  - API key for the pinning service
 *   IPFS_PINNING_API_SECRET - API secret (Pinata legacy)
 *   IPFS_CUSTOM_PINNING_URL - URL for custom pinning service
 *   AUDIT_CONCURRENCY     - Max concurrent checks (default: 8)
 *   AUDIT_TIMEOUT_MS      - Per-gateway timeout   (default: 15000)
 *   AUDIT_CREATED_AFTER   - Only audit drops created after this ISO date
 *   REPIN_ON_MISSING      - Set to "true" to automatically re-pin missing CIDs
 *   REDUNDANT_GATEWAYS    - Comma-separated gateways for redundant pinners
 *   REDUNDANT_API_KEYS    - Comma-separated API keys matching REDUNDANT_GATEWAYS
 *
 * Usage:
 *   # One-off audit
 *   node scripts/audit-pins.mjs
 *
 *   # Cron (every 6 hours, alert on missing)
 *   0 */6 * * * cd /opt/zairn && node packages/geo-drop/scripts/audit-pins.mjs || notify-team
 */

import { createClient } from '@supabase/supabase-js';
import { IpfsClient } from '../src/ipfs.js';
import { auditDropPins, repinMissing } from '../src/pin-monitor.js';

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[audit-pins] Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

function optional(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

function optionalList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = {
  info: (msg) => console.error(`[audit-pins] ${msg}`),
  warn: (msg) => console.error(`[audit-pins] WARN ${msg}`),
  error: (msg) => console.error(`[audit-pins] ERROR ${msg}`),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  // ---- Configuration ----
  const supabaseUrl = required('SUPABASE_URL');
  const supabaseKey = required('SUPABASE_SERVICE_KEY');

  const gateway = optional('IPFS_GATEWAY', 'https://w3s.link/ipfs');
  const fallbackGateways = optionalList('IPFS_FALLBACK_GATEWAYS');
  const pinningService = optional('IPFS_PINNING_SERVICE');
  const pinningApiKey = optional('IPFS_PINNING_API_KEY');
  const pinningApiSecret = optional('IPFS_PINNING_API_SECRET');
  const customPinningUrl = optional('IPFS_CUSTOM_PINNING_URL');

  const concurrency = parseInt(optional('AUDIT_CONCURRENCY', '8'), 10);
  const timeoutMs = parseInt(optional('AUDIT_TIMEOUT_MS', '15000'), 10);
  const createdAfter = optional('AUDIT_CREATED_AFTER');
  const repinOnMissing = optional('REPIN_ON_MISSING', 'false') === 'true';

  // ---- Clients ----
  const supabase = createClient(supabaseUrl, supabaseKey);

  const ipfs = new IpfsClient({
    gateway,
    fallbackGateways,
    pinningService,
    pinningApiKey,
    pinningApiSecret,
    customPinningUrl,
  });

  // ---- Audit ----
  log.info('Starting pin audit...');

  const report = await auditDropPins(supabase, ipfs, {
    concurrency,
    timeoutMs,
    createdAfter,
    onProgress: (checked, total) => {
      if (checked % 50 === 0 || checked === total) {
        log.info(`Progress: ${checked}/${total} CIDs checked`);
      }
    },
  });

  // ---- Summary ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log.info('--- Audit Summary ---');
  log.info(`Total drops with CID : ${report.totalWithCid}`);
  log.info(`Healthy (all gateways): ${report.healthy}`);
  log.info(`Degraded (partial)    : ${report.degraded}`);
  log.info(`Missing (unreachable) : ${report.missing}`);
  log.info(`Errors                : ${report.errors.length}`);
  log.info(`Elapsed               : ${elapsed}s`);

  // ---- Optional re-pin ----
  let repinResult = null;

  if (repinOnMissing && (report.missing > 0 || report.degraded > 0)) {
    const redundantGateways = optionalList('REDUNDANT_GATEWAYS');
    const redundantApiKeys = optionalList('REDUNDANT_API_KEYS');

    if (redundantGateways.length === 0) {
      log.warn('REPIN_ON_MISSING is true but no REDUNDANT_GATEWAYS configured. Skipping re-pin.');
    } else {
      const redundantPinners = redundantGateways.map((gw, i) =>
        new IpfsClient({
          gateway: gw,
          pinningService: pinningService,
          pinningApiKey: redundantApiKeys[i] || pinningApiKey,
        }),
      );

      log.info(`Re-pinning ${report.missing + report.degraded} CIDs to ${redundantPinners.length} pinner(s)...`);

      repinResult = await repinMissing(supabase, ipfs, redundantPinners, {
        onProgress: (processed, total) => {
          if (processed % 10 === 0 || processed === total) {
            log.info(`Re-pin progress: ${processed}/${total}`);
          }
        },
      });

      log.info(`Re-pin complete: ${repinResult.succeeded} succeeded, ${repinResult.failed} failed`);
    }
  }

  // ---- JSON output to stdout ----
  const output = {
    audit: report,
    repin: repinResult,
  };

  console.log(JSON.stringify(output, null, 2));

  // ---- Exit code ----
  if (report.missing > 0) {
    log.warn(`${report.missing} CID(s) are completely unreachable.`);
    process.exit(1);
  }

  if (report.degraded > 0) {
    log.warn(`${report.degraded} CID(s) have degraded availability.`);
    // Exit 0 for degraded -- not a hard failure but logged as warning.
  }

  process.exit(0);
}

main().catch((err) => {
  log.error(`Unhandled error: ${err.message ?? err}`);
  if (err.stack) log.error(err.stack);
  process.exit(2);
});
