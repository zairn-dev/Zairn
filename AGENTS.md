# Repository Guidelines

## Project Structure & Modules
- `README.md`: Quickstart for setting up Supabase and using the SDK.
- `database/schema.sql` and `database/policies.sql`: Core tables and RLS policies to apply in Supabase.
- `sdk/javascript/index.ts`: Minimal JS/TS SDK that wraps Supabase Auth, CRUD, and realtime helpers.

## Build, Test, and Development
- SDK ships as source only. In a consuming app, install `@supabase/supabase-js` and import from `sdk/javascript/index.ts`.
- Example TypeScript check from repo root: `tsc --noEmit sdk/javascript/index.ts` (requires a local `tsconfig` or defaults).
- Apply database changes via Supabase SQL Editor or CLI: `supabase db push` after copying the SQL files into your project.

## Coding Style & Naming
- Language: TypeScript (SDK) and SQL (database).
- Indentation: 2 spaces; prefer trailing commas and double quotes only when required by Supabase client options.
- Types: keep exported types (`ShareLevel`, `LocationCurrentRow`) narrow and reuse them in new helpers.
- Functions: favor small, composable async helpers returning typed results; keep Supabase table/column names in snake_case to mirror SQL.

## Testing Guidelines
- No dedicated test suite yet; for additions, add lightweight unit tests (e.g., Vitest/Jest) that mock Supabase client interactions.
- Name tests after behavior, e.g., `createLocationCore allows updates for authenticated user`.
- Always run static checks (`tsc --noEmit`) before submitting changes.

## Commit & PR Guidelines
- Follow Conventional Commit style where possible (`feat:`, `fix:`, `docs:`). Keep subject lines under ~72 chars.
- PRs should describe scope, mention related issues, and include any schema or SDK impacts.
- For SQL changes, summarize RLS implications and provide the exact statements touched. For SDK changes, note breaking API changes and update usage examples if needed.

## Security & Configuration Tips
- Keep `SUPABASE_URL` and keys in environment variables; do not commit them. Rotate keys if they were exposed.
- Ensure RLS remains enabled on all tables; any new table should include matching policies before exposing writes.
