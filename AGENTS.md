# Repository Guidelines

## Project Structure

pnpm monorepo with two packages and two apps:

- `packages/sdk/` — `@zen-map/sdk`: Location sharing SDK (Supabase wrapper)
- `packages/geo-drop/` — `@zen-map/geo-drop`: Location-bound encrypted drops with optional IPFS
- `apps/web/` — Main web frontend (Vite + React 19 + Tailwind CSS 4 + Leaflet)
- `apps/geo-drop-demo/` — GeoDrop demo app (Vite + React)
- `database/` — Core SQL schema and RLS policies
- `test/` — Integration tests

## Build, Test, and Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Dev servers
pnpm dev:web                          # Main web app
pnpm --filter geo-drop-demo dev       # GeoDrop demo

# Type check
pnpm --filter @zen-map/sdk exec tsc --noEmit
pnpm --filter @zen-map/geo-drop exec tsc --noEmit

# Build specific packages
pnpm --filter @zen-map/geo-drop build
pnpm --filter web build
```

Apply database changes via Supabase SQL Editor or CLI: `supabase db push`.

## Coding Style & Naming

- Language: TypeScript (SDK, apps) and SQL (database)
- Indentation: 2 spaces
- Types: keep exported types narrow and reuse them; table/column names in snake_case to mirror SQL
- Functions: favor small, composable async helpers returning typed results

## Testing Guidelines

- Integration tests in `test/` directory
- Run static checks (`tsc --noEmit`) before submitting changes
- Name tests after behavior, e.g., `createLocationCore allows updates for authenticated user`

## Commit & PR Guidelines

- Follow Conventional Commit style (`feat:`, `fix:`, `docs:`). Keep subject lines under 72 chars.
- For SQL changes, summarize RLS implications. For SDK changes, note breaking API changes.

## Security & Configuration Tips

- Keep `SUPABASE_URL`, keys, and IPFS credentials in environment variables; never commit them.
- Ensure RLS remains enabled on all tables; any new table must include matching policies.
- `.env` and `.env.local` are gitignored. Use `.env.example` files for documentation.
