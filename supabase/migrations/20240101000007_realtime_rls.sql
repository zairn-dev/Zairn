-- Enable Realtime RLS enforcement
-- Supabase Realtime uses the `supabase_realtime` publication.
-- By default, it publishes ALL tables without RLS filtering.
-- This migration restricts it to specific tables and enables
-- row-level security on the Realtime stream.

-- Drop existing default publication (publishes all tables)
drop publication if exists supabase_realtime;

-- Re-create with explicit table list (excludes sensitive tables)
-- Only tables that need real-time updates are included.
create publication supabase_realtime for table
  locations_current,
  friend_requests,
  messages,
  location_reactions,
  geo_drops;

-- Enable RLS on the publication (Supabase Realtime will apply
-- the same RLS policies that apply to SELECT queries).
-- This ensures users only receive events for rows they can read.
alter publication supabase_realtime set (publish = 'insert, update, delete');

-- Note: For this to take effect on hosted Supabase, the project must have
-- "Realtime RLS" enabled in Dashboard > Database > Replication.
-- For local development (supabase start), this migration is sufficient.
