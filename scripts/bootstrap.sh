#!/bin/bash

# Zairn Bootstrap Script - Automated One-Command Setup
set -e

echo "🚀 Starting Zairn bootstrap..."

# 1. Check for Docker
if ! docker info >/dev/null 2>&1; then
  echo "❌ Error: Docker is not running. Please start Docker and try again."
  exit 1
fi

# 2. Install dependencies
echo "📦 Installing dependencies..."
if command -v pnpm &> /dev/null; then
  pnpm install
else
  echo "⚠️ pnpm not found, falling back to npm..."
  npm install
fi

# 3. Start Supabase if needed
echo "🗄️ Checking Supabase status..."
if command -v supabase &> /dev/null; then
  if ! supabase status >/dev/null 2>&1; then
    echo "Starting local database..."
    supabase start
  else
    echo "✅ Supabase is already running."
  fi

  # 4. Configure .env
  if [ ! -f .env ]; then
    echo "📝 Creating .env from .env.example..."
    cp .env.example .env
    
    echo "🔗 Syncing local credentials from Supabase..."
    # Attempt to extract keys from supabase status
    # We use -o json if possible and parse with a simple grep/sed fallback
    SB_JSON=$(supabase status -o json 2>/dev/null || echo "{}")
    
    API_URL=$(echo "$SB_JSON" | grep -o '"API URL": "[^"]*' | cut -d'"' -f4 || echo "")
    ANON_KEY=$(echo "$SB_JSON" | grep -o '"anon key": "[^"]*' | cut -d'"' -f4 || echo "")
    
    if [ -n "$API_URL" ] && [ -n "$ANON_KEY" ]; then
      # Update .env file
      sed -i "s|^NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$API_URL|" .env
      sed -i "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY|" .env
      echo "✅ .env updated with local Supabase credentials."
    else
      echo "⚠️ Could not auto-detect Supabase credentials. Please update .env manually."
    fi
  fi
else
  echo "⚠️ Supabase CLI not found. Skipping DB auto-start."
fi

echo "✨ Bootstrap complete!"
echo "🚀 Starting web application..."

if command -v pnpm &> /dev/null; then
  pnpm dev:web
else
  npm run dev:web
fi
