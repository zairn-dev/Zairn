/**
 * Supabase Edge Function: create-drop
 *
 * Server-side GeoDrop creation: encrypts the content with a key derived from
 * the server secret, stores it (DB or IPFS via the server's Pinata key) and
 * records the drop. Clients never hold GEODROP_ENCRYPTION_SECRET.
 * The logic lives in ./handler.ts so it can be tested without serving.
 */
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { handleCreate } from './handler.ts'

serve((req: Request) => handleCreate(req))
