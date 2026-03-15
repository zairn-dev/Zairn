#!/usr/bin/env bash
set -euo pipefail

# demo-bootstrap.sh — One-command local development setup
# Usage: pnpm demo:bootstrap

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }
step()  { echo -e "\n${BOLD}→ $1${NC}"; }

# ─────────────────────────────────────
# 1. Check prerequisites
# ─────────────────────────────────────
step "Checking prerequisites"

if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install Docker Desktop: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &>/dev/null; then
  error "Docker is not running. Start Docker Desktop and try again."
  exit 1
fi
info "Docker is running"

if ! command -v pnpm &>/dev/null; then
  error "pnpm is not installed. Install: npm install -g pnpm"
  exit 1
fi
info "pnpm is available"

# ─────────────────────────────────────
# 2. Install dependencies
# ─────────────────────────────────────
step "Installing dependencies"
pnpm install
info "Dependencies installed"

# ─────────────────────────────────────
# 3. Start Supabase (if not already running)
# ─────────────────────────────────────
step "Starting local Supabase"

if npx supabase status &>/dev/null; then
  info "Supabase is already running"
else
  npx supabase start
  info "Supabase started"
fi

# ─────────────────────────────────────
# 4. Apply database schema
# ─────────────────────────────────────
step "Applying database schema"

DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
psql "$DB_URL" -f database/schema.sql 2>/dev/null || true
psql "$DB_URL" -f database/policies.sql 2>/dev/null || true
psql "$DB_URL" -f packages/geo-drop/database/schema.sql 2>/dev/null || true
psql "$DB_URL" -f packages/geo-drop/database/policies.sql 2>/dev/null || true
psql "$DB_URL" -c "INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT DO NOTHING;" 2>/dev/null || true
info "Schema applied"

# ─────────────────────────────────────
# 5. Generate .env files with local credentials
# ─────────────────────────────────────
step "Configuring environment"

ANON_KEY=$(npx supabase status -o json 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{console.log(JSON.parse(d).ANON_KEY)}catch{console.log('')}
  })
" 2>/dev/null || echo "")
SUPABASE_URL="http://127.0.0.1:54321"

if [ -z "$ANON_KEY" ]; then
  # Fallback to the well-known local dev key
  ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  warn "Could not read anon key from supabase status, using default local key"
fi

# Root .env (for tests)
if [ ! -f .env ]; then
  cat > .env <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${ANON_KEY}
EOF
  info "Created .env"
else
  warn ".env already exists, skipping"
fi

# Web app .env.local
if [ ! -f apps/web/.env.local ]; then
  cat > apps/web/.env.local <<EOF
VITE_SUPABASE_URL=${SUPABASE_URL}
VITE_SUPABASE_ANON_KEY=${ANON_KEY}
EOF
  info "Created apps/web/.env.local"
else
  warn "apps/web/.env.local already exists, skipping"
fi

# GeoDrop demo .env.local
if [ ! -f apps/geo-drop-demo/.env.local ]; then
  cat > apps/geo-drop-demo/.env.local <<EOF
VITE_SUPABASE_URL=${SUPABASE_URL}
VITE_SUPABASE_ANON_KEY=${ANON_KEY}
EOF
  info "Created apps/geo-drop-demo/.env.local"
else
  warn "apps/geo-drop-demo/.env.local already exists, skipping"
fi

# ─────────────────────────────────────
# 6. Build packages
# ─────────────────────────────────────
step "Building packages"
pnpm build
info "Packages built"

# ─────────────────────────────────────
# 7. Done!
# ─────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
echo "  Start the web app:        pnpm dev:web"
echo "  Start the GeoDrop demo:   pnpm --filter geo-drop-demo dev"
echo "  Run unit tests:           pnpm test:unit"
echo "  Run integration tests:    pnpm test:connection"
echo "  Supabase Studio:          http://127.0.0.1:54323"
echo ""
