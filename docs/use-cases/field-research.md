# Field Research Tools

## Problem

Researchers conducting field work -- ecological surveys, archaeological digs, public health studies -- need accurate location history to document where observations were made. At the same time, they must protect participant and researcher privacy: publishing raw GPS trails can reveal home addresses, daily routines, and sensitive site locations. Ethics boards and data protection regulations (GDPR, IRB protocols) demand that location data be handled with minimal disclosure.

## Solution with Zairn

Combine `@zairn/sdk` for location trail recording and export with `@zairn/geo-drop` ZKP (zero-knowledge proof) capabilities. Researchers record their movements during field sessions, then use Groth16-based proximity proofs to verify "the researcher was within the study area" without revealing the exact path. Sharing policies enforce consent-based access control.

- **Location trails** -- `sendLocationWithTrail()` records both current position and history in a single call.
- **History export** -- `getLocationHistory()` retrieves timestamped trails for analysis and reporting.
- **ZKP verification** -- `generateProximityProof()` produces a cryptographic proof of proximity to a study site without disclosing coordinates.
- **Sharing policies** -- fine-grained rules control who sees what, with time and geofence conditions for consent management.

## Code Snippet

```typescript
import { createLocationCore } from '@zairn/sdk';
import { createGeoDrop } from '@zairn/geo-drop';
import { generateProximityProof, verifyProximityProof } from '@zairn/geo-drop/zkp';

const core = createLocationCore({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
});

const geo = createGeoDrop({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  encryptionSecret: process.env.ENCRYPTION_SECRET!,
});

// ---- Step 1: Record field session trail ----

// Researcher sends location updates during a survey walk
await core.sendLocationWithTrail({
  lat: 36.2048,
  lon: 137.2529,
  accuracy: 5,
  speed: 0.8,     // slow walking pace
});

// ... additional points recorded as the researcher moves ...

await core.sendLocationWithTrail({
  lat: 36.2055,
  lon: 137.2535,
  accuracy: 4,
  speed: 1.1,
});

// ---- Step 2: Export location history for analysis ----

const userId = (await core.supabase.auth.getUser()).data.user!.id;

const trail = await core.getLocationHistory(userId, {
  since: new Date('2026-03-15T08:00:00Z'),
  limit: 500,
});

console.log(`Recorded ${trail.length} trail points`);

// Compute total distance walked
let totalMeters = 0;
for (let i = 1; i < trail.length; i++) {
  totalMeters += core.calculateDistance(
    trail[i - 1].lat, trail[i - 1].lon,
    trail[i].lat, trail[i].lon,
  );
}
console.log(`Total distance: ${(totalMeters / 1000).toFixed(2)} km`);

// ---- Step 3: ZKP -- prove presence in study area without revealing path ----

// Study area center and radius (e.g., a nature reserve)
const studyAreaLat = 36.2050;
const studyAreaLon = 137.2530;
const studyAreaRadiusMeters = 500;

// Generate a proof that the researcher was within the study area
// Private inputs: researcher's actual coordinates (never sent to verifier)
// Public inputs: study area center + radius (known to both parties)
const proof = await generateProximityProof(
  36.2048,            // researcher's actual lat (private)
  137.2529,           // researcher's actual lon (private)
  studyAreaLat,       // study area center lat (public)
  studyAreaLon,       // study area center lon (public)
  studyAreaRadiusMeters,
  {
    wasmPath: '/circuits/zairn_zkp.wasm',
    zkeyPath: '/circuits/zairn_zkp_final.zkey',
  },
);

// The proof object contains { proof, publicSignals } but NOT the researcher's coordinates

// ---- Step 4: Verifier confirms presence without learning the path ----

const isValid = await verifyProximityProof(
  proof.proof,
  proof.publicSignals,
  verificationKey,  // from the trusted setup
);

console.log(`Researcher was in study area: ${isValid}`);
// => true, but the verifier never learned the exact coordinates

// ---- Step 5: Consent-based sharing policy for collaborators ----

// Only share trail data with the PI during working hours
await core.addSharingPolicy({
  viewer_id: principalInvestigatorId,
  conditions: [
    { type: 'time_range', start: '08:00', end: '18:00', timezone: 'Asia/Tokyo' },
  ],
  effect_level: 'history',
  priority: 10,
  label: 'PI access during field hours',
});

// Coarsen location for other team members (1 km resolution)
await core.addSharingPolicy({
  conditions: [
    { type: 'time_range', start: '08:00', end: '18:00', timezone: 'Asia/Tokyo' },
  ],
  effect_level: 'coarse',
  coarse_radius_m: 1000,
  priority: 5,
  label: 'Team members see approximate area only',
});
```

## Next Steps

- **Encrypted data drops at observation sites** -- Use `createDrop()` to leave encrypted field notes (photos, audio memos) at each observation point. Only authorized team members with GPS proximity can unlock them.
- **Anonymous data aggregation** -- Combine ZKP proofs from multiple researchers to build aggregate presence maps ("12 researchers visited the north quadrant this week") without any individual trail being disclosed.
- **Automated consent revocation** -- Set `expires_at` on share rules so access to trail data automatically expires when the study period ends, satisfying IRB requirements.
- **Geofenced data sensitivity** -- Add sharing policies with `geofence` conditions to automatically hide location when researchers are near participant homes or other sensitive areas.
