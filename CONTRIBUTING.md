# Contributing to zairn

Thank you for your interest in contributing! Whether it's code, documentation, example apps, bug reports, or research — all contributions are welcome.

## Getting Started

### Quick start (one command)

```bash
git clone https://github.com/your-username/Zairn.git
cd Zairn
pnpm demo:bootstrap
# → installs deps, starts Supabase, applies schema, creates .env, builds
```

Requires Docker Desktop running. After bootstrap, start the app:

```bash
pnpm dev:web                  # Main web app at http://localhost:5173
pnpm --filter geo-drop-demo dev   # GeoDrop demo
```

### Manual setup

<details>
<summary>Step-by-step (if bootstrap doesn't work for your environment)</summary>

#### 1. Fork & clone

```bash
git clone https://github.com/your-username/Zairn.git
cd Zairn
pnpm install
```

#### 2. Start local Supabase

```bash
# Requires Docker Desktop running
pnpm db:start
```

The CLI prints local credentials (URL, anon key). Use these in `.env`:

```bash
cp .env.example .env          # Uncomment local lines
cp apps/web/.env.example apps/web/.env.local
```

#### 3. Run the app

```bash
pnpm dev:web                  # Main web app at http://localhost:5173
pnpm --filter geo-drop-demo dev   # GeoDrop demo
```

</details>

### 4. Run tests

```bash
# Unit tests (no Supabase required)
pnpm test:unit                # geo-drop crypto, geofence, trust-scorer, zkp, encrypted-search

# Integration tests (require local Supabase running)
pnpm test:connection          # Database connectivity
pnpm test:sdk                 # SDK core functions
pnpm test:features            # Social features (chat, groups, reactions)
pnpm test:auth                # Authentication
pnpm test:chat                # Chat & bump
```

### 5. Type check

```bash
pnpm --filter @zairn/sdk exec tsc --noEmit
pnpm --filter @zairn/geo-drop build
npx tsc --noEmit -p apps/web/tsconfig.json
npx tsc --noEmit -p apps/geo-drop-demo/tsconfig.json
```

## What to work on

- Issues labeled [`good first issue`](https://github.com/zairn-dev/Zairn/labels/good%20first%20issue) — self-contained, well-scoped tasks
- Issues labeled [`help wanted`](https://github.com/zairn-dev/Zairn/labels/help%20wanted) — we'd appreciate help
- [GitHub Discussions](https://github.com/zairn-dev/Zairn/discussions) — ask questions, share ideas, show what you've built

## Database Changes

- Update `database/schema.sql` for table definitions
- Add RLS policies in `database/policies.sql`
- Use `security definer` helper functions if policies reference the same table (avoids infinite recursion)
- Document RLS implications in your PR

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use |
|--------|-----|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation |
| `refactor:` | Code refactoring |
| `test:` | Tests |
| `chore:` | Maintenance |

Keep the subject line under 72 characters. Note breaking changes and RLS impact.

## Pull Requests

1. Create a branch: `git checkout -b feat/your-feature`
2. Keep PRs focused — one feature or fix per PR
3. Ensure all type checks pass
4. Fill out the PR template
5. Link related issues

## Code Style

- TypeScript strict mode
- 2-space indentation
- `snake_case` for database columns
- `camelCase` for TypeScript
- Material 3 CSS variables (`var(--md-primary)`) for UI

## Writing Tests

- **Unit tests** go in `packages/geo-drop/test/*.test.ts` (vitest)
  - Pure function tests — no Supabase dependency
  - Run with `pnpm test:unit` or `pnpm --filter @zairn/geo-drop test`
  - Use `vitest --watch` during development
- **Integration tests** go in `test/*.ts` (tsx scripts)
  - Require a running Supabase instance
  - Use `.env` for credentials

When adding new pure functions (crypto, geofence, scoring), add unit tests.
When adding features that interact with Supabase, add integration tests.

## Releases

We release every 2 weeks with auto-generated release notes.

**How it works:**
1. Maintainer creates a GitHub Release (tag: `v0.x.y`) from `main`
2. Release notes are auto-generated from merged PRs, categorized by label (see `.github/release.yml`)
3. The `publish.yml` workflow automatically publishes `@zairn/sdk` and `@zairn/geo-drop` to npm

**Versioning:** We follow [SemVer](https://semver.org/). During `0.x`, minor bumps may include breaking changes.

## Project Structure

```
packages/sdk/        — @zairn/sdk (location sharing)
packages/geo-drop/   — @zairn/geo-drop (encrypted drops)
apps/web/            — Main web app
apps/geo-drop-demo/  — GeoDrop demo app
database/            — SQL schema and RLS policies
test/                — Integration tests
```
