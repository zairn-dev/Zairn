import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { buildSnapshot } from '../../scripts/build-db-snapshot.mjs';
import { REPO_ROOT } from './harness.mjs';

const snapshotPath = join(REPO_ROOT, 'database', 'schema.sql');

test('database/schema.sql matches supabase/migrations (run `pnpm db:snapshot`)', () => {
  const current = readFileSync(snapshotPath, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(current === buildSnapshot(), 'database/schema.sql is out of date');
});

test('database/schema.sql applies as a single file on a fresh database', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(REPO_ROOT, 'test', 'db', 'supabase-shim.sql'), 'utf8'));
  await db.exec('set search_path = public, extensions');
  await db.exec(readFileSync(snapshotPath, 'utf8'));
  const { rows } = await db.query("select count(*)::int as n from pg_policies where schemaname = 'public'");
  assert.ok(rows[0].n > 50, `expected the full policy set, got ${rows[0].n}`);
});
