/**
 * Bundle the shipped privacy artifact for the browser harness.
 *
 * The on-device harness (harness/index.html) needs the REAL SDK code paths
 * — createSensingGateController (the gate) and createPrivacyProcessor (the
 * naive post-acquisition pipeline) — running in Android Chrome. This bundles the
 * already-compiled ESM module
 *   packages/sdk/dist/privacy-location.js
 * into a single self-contained IIFE that exposes `window.ZairnPrivacy`, so
 * the page loads with a plain <script> tag and works from file:// with no
 * module resolver and no network.
 *
 * esbuild is already present transitively (dependency of the apps' Vite);
 * this script adds NO new dependency. Run:  node bundle-sdk.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../../../packages/sdk/dist/privacy-location.js');
const OUT = join(HERE, 'harness', 'vendor', 'zairn-privacy.js');

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`[bundle-sdk] SDK dist not found: ${ENTRY}`);
    console.error('[bundle-sdk] build the SDK first:  pnpm --filter @zairn/sdk build');
    process.exit(1);
  }
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('[bundle-sdk] esbuild not resolvable. It ships transitively with Vite;');
    console.error('[bundle-sdk] run `pnpm install` at the repo root, then retry.');
    process.exit(1);
  }
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: 'ZairnPrivacy',
    platform: 'browser',
    target: ['es2020'],
    outfile: OUT,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
  });
  const out = Object.values(result.metafile.outputs)[0];
  console.log(`[bundle-sdk] wrote ${OUT}`);
  console.log(`[bundle-sdk] bytes=${out?.bytes ?? '?'}  global=window.ZairnPrivacy`);
  console.log('[bundle-sdk] exposed: createSensingGate, createSensingGateController, runSensingCycle, createPrivacyProcessor, detectSensitivePlaces, DEFAULT_PRIVACY_CONFIG, DEFAULT_GATE_CONFIG');
}

main().catch((e) => { console.error(e); process.exit(1); });
