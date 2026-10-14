# Supabase Production Setup Guide

## Prerequisites

- Supabase project created at [supabase.com](https://supabase.com)
- `supabase` CLI installed
- Project linked: `supabase link --project-ref <your-ref>`

## 1. Apply Migrations

```bash
supabase db push
```

This applies all migrations in `supabase/migrations/`, including:
- Core schema (tables, functions, triggers)
- RLS policies
- GeoDrop schema
- Realtime publication configuration

Projects first deployed from early versions of migrations 0001–0012 lack
functions, triggers, constraints and policies that were added to those files
later. `20261014000017_reconcile_production_drift.sql` brings such a project
up to date before `20261014000018` runs; on a project built from the current
migrations its only effect is the GeoDrop policy-recursion fix. It deletes `locations_current`,
`locations_history` and `share_rules` rows that belong to deleted accounts
before adding the missing `ON DELETE CASCADE` foreign keys. If `db push` fails
with `function ... does not exist` on an older project, check that this file
is present.

## 2. Enable Realtime RLS (Required)

The migration `20240101000007_realtime_rls.sql` creates the publication,
but **Realtime RLS must also be enabled in the dashboard**:

1. Go to **Dashboard → Database → Replication**
2. Find the `supabase_realtime` publication
3. Enable **"RLS enabled"** toggle
4. Verify the publication includes only:
   - `locations_current`
   - `friend_requests`
   - `messages`
   - `location_reactions`
   - `geo_drops`

Without this step, all authenticated users receive ALL row changes
via Realtime, regardless of RLS policies.

## 3. Deploy Edge Functions

```bash
supabase secrets set GEODROP_ENCRYPTION_SECRET=<your-256-bit-hex-secret>
supabase secrets set PINATA_JWT=<your-pinata-jwt>
supabase secrets set IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs
# Only if drops may require ZK proofs: contents of circuits/sound_geo_only_vkey.json
supabase secrets set GEODROP_ZKP_VKEY="$(cat packages/geo-drop/circuits/sound_geo_only_vkey.json)"

supabase functions deploy create-drop
supabase functions deploy unlock-drop
supabase functions deploy ipfs-proxy
```

- `create-drop` encrypts drop content with a key derived from
  `GEODROP_ENCRYPTION_SECRET`; `unlock-drop` decrypts it after verifying the
  claimant. Browsers never hold the secret — the SDK uses these functions
  automatically when `serverUnlock` is set and no `encryptionSecret` is passed.
- Secret rotation: add `GEODROP_ENCRYPTION_SECRET_V2=<new>` and set
  `GEODROP_CURRENT_SECRET_VERSION=2`. New drops use v2; existing drops keep
  decrypting with the version they were created with.
- `GEODROP_ZKP_VKEY` must be the `sound_geo_only` key (5 public signals).
  Never the `proximity` key: that circuit proves nothing about distance.

### CORS Configuration

Set `CORS_ORIGIN` to your frontend origin(s), comma-separated:

```bash
supabase secrets set CORS_ORIGIN=https://your-app.com,https://demo.your-app.com
```

If unset, browsers are refused (no `Access-Control-Allow-Origin` is sent).
Wildcards are not supported.

## 4. Storage Setup

The migration creates an `avatars` storage bucket. Verify:

1. Go to **Dashboard → Storage**
2. Confirm `avatars` bucket exists with public access

## 5. Authentication

1. Go to **Dashboard → Authentication → Settings**
2. Configure:
   - **Site URL**: `https://your-app.com`
   - **Redirect URLs**: Add your app URL
   - **Email confirmations**: Enable for production
   - **Rate limiting**: Enable (default is sufficient)

## 6. Environment Variables

### Web App (`apps/web/.env.local`)
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

### GeoDrop Demo (`apps/geo-drop-demo/.env`)
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
# Use server-side proxy, NOT client-side IPFS key:
VITE_IPFS_PROXY_URL=https://<project-ref>.supabase.co/functions/v1/ipfs-proxy
```

### SDK Server-Side
```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
GEODROP_ENCRYPTION_SECRET=<your-256-bit-hex-secret>
```

## 7. Security Checklist

- [ ] Realtime RLS enabled in dashboard
- [ ] All migrations applied (`supabase db push`), then `node scripts/migrate-proof-secrets.mjs`
- [ ] `node scripts/check-realtime-rls.mjs` passes against the deployed project
- [ ] create-drop, unlock-drop and ipfs-proxy deployed with CORS_ORIGIN set
- [ ] GEODROP_ENCRYPTION_SECRET is a 256-bit random hex string and appears in no client env file
- [ ] Email confirmations enabled
- [ ] IPFS keys are server-side only (not in VITE_ variables)
- [ ] Database backups enabled (Supabase Pro plan)
- [ ] Monitoring alerts configured for Edge Function errors

## 8. ZKP Trusted Setup (Before Production)

The current `.zkey` files are from a single-contributor ceremony (development only).
For production, run a multi-party ceremony:

```bash
cd packages/geo-drop/circuits/ceremony
./run-ceremony.sh
```

See `circuits/ceremony/README.md` for full instructions.
