/**
 * Supabase Edge Function: unlock-drop
 *
 * Server-side drop unlock — authorizes the caller, verifies location and
 * proof requirements, decrypts content, records the claim, returns plaintext.
 * The client never sees encryption keys or encrypted content.
 *
 * POST /unlock-drop
 * Headers: Authorization: Bearer <user_jwt>
 * Body: { drop_id, lat, lon, accuracy?, password?, proofs? }
 *
 * Returns: { content, claim, verification }
 * Errors carry a machine-readable `code` (e.g. step_up_required).
 * The logic lives in ./handler.ts so it can be tested without serving.
 */
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { handleUnlock } from './handler.ts'

serve((req: Request) => handleUnlock(req))
