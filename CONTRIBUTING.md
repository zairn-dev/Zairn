# Contributing to zairn

Thank you for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/zairn.git`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feat/your-feature`

## Development

```bash
# Start the web app
pnpm dev:web

# Start the GeoDrop demo
pnpm --filter geo-drop-demo dev

# Type check everything
pnpm --filter @zairn/sdk exec tsc --noEmit
pnpm --filter @zairn/geo-drop build
npx tsc --noEmit -p apps/web/tsconfig.json
npx tsc --noEmit -p apps/geo-drop-demo/tsconfig.json
```

## Database Changes

- Always update `database/schema.sql` with new table definitions
- Add RLS policies in `database/policies.sql`
- Document RLS implications in your PR

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `refactor:` — Code refactoring
- `chore:` — Maintenance

## Pull Requests

1. Keep PRs focused — one feature or fix per PR
2. Update types if you change the database schema
3. Ensure all type checks pass before submitting
4. Fill out the PR template

## Project Structure

```
packages/sdk/        — @zairn/sdk (location sharing)
packages/geo-drop/   — @zairn/geo-drop (encrypted drops)
apps/web/            — Main web app
apps/geo-drop-demo/  — GeoDrop demo app
database/            — SQL schema and RLS policies
```

## Code Style

- TypeScript with strict mode
- 2-space indentation
- snake_case for database columns
- camelCase for TypeScript
- Material 3 CSS variables for UI styling
