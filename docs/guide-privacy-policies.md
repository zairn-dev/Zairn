# Privacy Policies Guide

This guide explains how to use Zairn's privacy system to protect user locations.

## Overview

Zairn provides two layers of privacy control:

1. **Privacy Processor** — Automatic per-location defense (noise, zones, adaptive reporting)
2. **Sharing Policies** — Per-viewer, context-dependent visibility rules

## Quick Start: Privacy Processor

The simplest way to add privacy protection:

```ts
import {
  createPrivacyProcessor,
  DEFAULT_PRIVACY_CONFIG,
  detectSensitivePlaces,
} from '@zairn/sdk';

// 1. Create processor (validates config, manages state internally)
const privacy = createPrivacyProcessor({
  ...DEFAULT_PRIVACY_CONFIG,
  gridSeed: currentUser.id,  // REQUIRED: unique per user
}, sensitivePlaces);

// 2. On each GPS update, process before sharing
const state = privacy.process(rawLat, rawLon);

switch (state.type) {
  case 'coarse':
    // Share state.lat, state.lon, state.cellId — grid-snapped + noisy
    shareWithFriends(state);
    break;
  case 'state':
    // Share "At home" / "At work" — no coordinates
    shareStateOnly(state.label);
    break;
  case 'suppressed':
    // Don't share anything (privacy zone or budget exhausted)
    break;
}
```

## The 6 Defense Layers

| Layer | What it does | Why it matters |
|-------|-------------|----------------|
| 1. Planar Laplace | Adds calibrated random noise | Formal ε-differential privacy per observation |
| 2. Grid Snap | Snaps to per-user grid cells | Deterministic display + prevents coordinate leakage |
| 3. Sensitive Places | Detects home/work on-device | Enables zone-based protection |
| 4. Privacy Zones | Core: state-only, Buffer: amplified noise | Prevents home/work inference |
| 5. Adaptive Reporting | Exponential backoff when stationary | Limits temporal accumulation |
| 6. Distance Bucketing | Coarse distance categories | Prevents trilateration attacks |

## Configuring Privacy

Key parameters in `PrivacyConfig`:

```ts
{
  // Privacy strength (smaller = more private, noisier)
  baseEpsilon: Math.LN2 / 500,  // ln(2)-indistinguishability within 500m

  // Grid cell size (larger = less precise for viewers)
  gridSizeM: 500,

  // Per-user grid offset seed (MUST be unique per user)
  gridSeed: user.id,

  // Zone sizes
  defaultZoneRadiusM: 200,    // Core zone: state-only
  defaultBufferRadiusM: 1000, // Buffer zone: amplified noise

  // Reporting frequency
  maxReportsPerHourMoving: 12,
  maxReportsPerHourStationary: 2,
}
```

## Sensitive Place Detection

Automatically detect home/work from location history:

```ts
const places = detectSensitivePlaces(locationHistory, config);
// Returns: [{ label: 'home', lat, lon, radiusM, ... }, ...]

// Update the processor
privacy.updateSensitivePlaces(places);
```

Detection runs entirely on-device. No location data leaves the client.

## Sharing Policies (Per-Viewer Control)

For per-viewer visibility rules, use the policy engine:

```ts
import { evaluatePolicies } from '@zairn/sdk';

const { level, wasClamped } = evaluatePolicies(
  policies,
  viewerId,
  { ownerLat, ownerLon, viewerLat, viewerLon, now: new Date() },
  fallbackShareLevel,
);

// wasClamped: true if policy tried to escalate beyond static share_rules
// This prevents a time-based policy from granting more access than the
// user explicitly allowed.
```

### Example: Show coarse location to coworkers during work hours

```ts
await core.addSharingPolicy({
  viewer_id: null,  // all friends
  effect_level: 'coarse',
  coarse_radius_m: 2000,
  conditions: [
    { type: 'time_range', start: '09:00', end: '18:00', timezone: 'Asia/Tokyo' },
    { type: 'day_of_week', days: [1, 2, 3, 4, 5] },
  ],
  priority: 10,
  enabled: true,
});
```

## Security Notes

- **Realtime RLS**: Ensure Realtime RLS is enabled in Supabase Dashboard. Without it, all authenticated users receive all location updates. The SDK warns at startup if `suppressRealtimeRlsWarning` is not set.
- **Grid seed**: Must be unique per user. Using a shared seed enables cross-user grid correlation attacks.
- **Zone detection**: Requires sufficient location history (5+ visits, 60+ min dwell). New users have no protection until history builds up — consider providing manual "set home" UI.
