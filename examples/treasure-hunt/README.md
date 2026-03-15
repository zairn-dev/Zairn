# Treasure Hunt Example

A location-based treasure hunt game using `@zairn/geo-drop`.

Demonstrates:
- Create encrypted drops at map locations
- Walk to a drop and unlock with GPS proximity
- Display locked/unlocked drops on a Leaflet map

## Setup

```bash
# From the repo root
pnpm demo:bootstrap    # or manual: pnpm install && pnpm db:start

# Start the example
pnpm --filter treasure-hunt-example dev
```

## How to play

1. Sign in (or sign up)
2. **Hide treasure**: Click anywhere on the map to create a drop with a secret message
3. **Find treasure**: Red markers are locked drops. Walk within the unlock radius and click "Try Unlock"
4. **Win**: Green markers are drops you've unlocked. The secret content is revealed!

## How it works

1. **Create** — `geo.createDrop()` encrypts content with AES-256-GCM, key derived from geohash + dropId
2. **Discover** — `geo.findNearbyDrops()` queries within a radius (content stays encrypted)
3. **Unlock** — `geo.unlockDrop()` verifies GPS proximity, decrypts content, and records a claim
4. **Security** — Content cannot be decrypted without being at the physical location
