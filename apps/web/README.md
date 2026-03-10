# zairn Web App

The main web frontend for zairn. A real-time location sharing app with map visualization, friend management, chat, and more.

## Tech Stack

- **Vite** + **React 19** + **TypeScript**
- **Tailwind CSS 4** with Material 3 design tokens
- **Leaflet** / **react-leaflet** for map rendering
- **@zairn/sdk** for Supabase integration

## Features

- Interactive map with friend locations
- Trail visualization (movement history)
- Area exploration grid
- Friend management (add, remove, requests)
- Direct and group chat
- Location reactions (emoji pokes)
- Bump detection
- Profile and settings management
- Ghost mode

## Development

```bash
# From the monorepo root
pnpm dev:web

# Or from this directory
pnpm dev
```

## Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
