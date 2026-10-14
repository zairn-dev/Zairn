// Regenerates database/schema.sql: the full schema as one file, built by
// concatenating supabase/migrations in order. The migrations are the single
// source of truth; this snapshot exists for setups that paste SQL into the
// Supabase SQL editor instead of using the CLI.
//
// Usage: node scripts/build-db-snapshot.mjs [--check]
//   --check  exit 1 if database/schema.sql is out of date (used by tests)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const OUT = join(ROOT, 'database', 'schema.sql');

export function buildSnapshot() {
  const parts = [
    '-- =====================================================================',
    '-- GENERATED FILE — do not edit by hand.',
    '-- Source of truth: supabase/migrations/ (applied in filename order).',
    '-- Regenerate with: pnpm db:snapshot',
    '--',
    '-- Apply to a fresh Supabase project in the SQL editor, or prefer the CLI:',
    '--   supabase db push',
    '-- =====================================================================',
    '',
  ];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    parts.push(`-- ---------------------------------------------------------------------`);
    parts.push(`-- migration: ${file}`);
    parts.push(`-- ---------------------------------------------------------------------`);
    parts.push(sql.trimEnd(), '');
  }
  return parts.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const snapshot = buildSnapshot();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== snapshot) {
      console.error('database/schema.sql is out of date — run `pnpm db:snapshot`.');
      process.exit(1);
    }
    console.log('database/schema.sql is up to date.');
  } else {
    writeFileSync(OUT, snapshot);
    console.log(`wrote ${OUT}`);
  }
}
