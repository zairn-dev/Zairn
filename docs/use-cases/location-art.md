# Location-Based Art Installations

## Problem

Artists and galleries want to create site-specific digital experiences tied to physical locations. Traditional digital art can be viewed from anywhere, removing the connection between artwork and place. There is no simple way to ensure that a viewer is physically present at a gallery, sculpture garden, or outdoor installation before revealing the digital layer of a piece.

## Solution with Zairn

Use `@zairn/geo-drop` to encrypt digital content (images, audio, video) at specific GPS coordinates. Visitors must physically travel to each artwork's location and be within the unlock radius to decrypt and view the content. This creates a direct bond between the physical site and the digital experience.

- **Encrypted at rest** -- content is AES-encrypted with a location-derived key; no one can preview it remotely.
- **GPS-gated unlock** -- the SDK verifies the visitor's coordinates before decrypting.
- **Multi-format** -- supports image, audio, video, and file content types for rich mixed-media installations.
- **Optional IPFS persistence** -- store encrypted payloads on IPFS so the artwork outlives any single server.

## Code Snippet

```typescript
import { createGeoDrop } from '@zairn/geo-drop';

const geo = createGeoDrop({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  encryptionSecret: process.env.ENCRYPTION_SECRET!,
});

// --- Artist: place a digital artwork at a gallery entrance ---
const drop = await geo.createDrop(
  {
    title: 'Ephemeral Light #3',
    description: 'A generative light study visible only from the north gallery.',
    content_type: 'image',
    lat: 35.6762,
    lon: 139.6503,
    unlock_radius_meters: 15,   // must be within 15 m of the piece
    visibility: 'public',
    expires_at: new Date('2026-06-01'), // exhibition end date
  },
  imageBase64String, // the encrypted artwork content
);

console.log(`Drop created: ${drop.id}`);

// --- Visitor: arrive at the gallery and unlock ---
const nearby = await geo.findNearbyDrops(35.6763, 139.6504, 100);

for (const entry of nearby) {
  if (entry.can_unlock) {
    const { content } = await geo.unlockDrop(
      entry.drop.id,
      35.6763,   // visitor lat
      139.6504,  // visitor lon
      5,         // GPS accuracy in meters
    );
    // `content` is the decrypted image data -- render it in the app
    console.log(`Unlocked "${entry.drop.title}"`);
  }
}
```

## Next Steps

- **AR verification** -- Add an `ar` proof requirement so visitors must also point their camera at the physical sculpture. This uses DINOv2 feature matching to confirm they see the real landmark, not a photo on a screen.
- **ZKP for privacy-preserving experiences** -- Use `generateProximityProof()` to let visitors prove they were within range without revealing their exact GPS coordinates to the gallery server. Useful when the gallery wants attendance analytics without tracking individuals.
- **Chained installations** -- Create a walking tour where each drop's decrypted content reveals a hint about the next location, guiding visitors through a curated path.
- **On-chain persistence** -- Set `persistence: 'full'` to anchor artwork metadata on-chain, creating a permanent record that the piece existed at that location.
