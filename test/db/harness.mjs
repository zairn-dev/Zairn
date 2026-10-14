// Builds a database from supabase/migrations on an embedded Postgres (PGlite)
// and runs statements as a given Supabase role/user, for RLS and privilege
// regression tests that need no Docker or hosted project.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Apply every migration in filename order, each in its own transaction, the
 * way `supabase db push` does. Stops at the first failure unless keepGoing.
 */
export async function freshDb({ keepGoing = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(HERE, 'supabase-shim.sql'), 'utf8'));
  await db.exec('set search_path = public, extensions');
  const failures = [];
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/^﻿/, '');
    try {
      await db.transaction(async (tx) => { await tx.exec(sql); });
    } catch (e) {
      failures.push({ file, error: e.message });
      if (!keepGoing) break;
    }
  }
  return { db, failures };
}

export async function createUser(db, email = `${crypto.randomUUID()}@test.local`) {
  const { rows } = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

/**
 * Run fn(tx) inside a transaction as `role` with auth.uid() = uid.
 * Any error rolls the transaction back and rejects.
 */
export async function as(db, uid, fn, role = 'authenticated') {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)",
      [uid ?? '', role],
    );
    return fn(tx);
  });
}

export const asAnon = (db, fn) => as(db, null, fn, 'anon');
export const asService = (db, fn) => as(db, null, fn, 'service_role');
