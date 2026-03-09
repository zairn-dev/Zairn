-- Migration: Add missing columns, tables, types, and functions
-- Run this against your Supabase project to bring the schema up to date.

-- =====================
-- Missing types
-- =====================
DO $$ BEGIN
  CREATE TYPE motion_type AS ENUM ('stationary', 'walking', 'running', 'cycling', 'driving', 'transit', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE place_type AS ENUM ('home', 'work', 'school', 'gym', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================
-- Missing columns on locations_current
-- =====================
ALTER TABLE locations_current ADD COLUMN IF NOT EXISTS battery_level smallint CHECK (battery_level >= 0 AND battery_level <= 100);
ALTER TABLE locations_current ADD COLUMN IF NOT EXISTS is_charging boolean DEFAULT false;
ALTER TABLE locations_current ADD COLUMN IF NOT EXISTS location_since timestamptz DEFAULT now();
ALTER TABLE locations_current ADD COLUMN IF NOT EXISTS speed real;
ALTER TABLE locations_current ADD COLUMN IF NOT EXISTS motion motion_type DEFAULT 'unknown';

-- =====================
-- Missing columns on profiles
-- =====================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_emoji text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_text text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_expires_at timestamptz;

-- =====================
-- Missing tables
-- =====================
CREATE TABLE IF NOT EXISTS favorite_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  place_type place_type NOT NULL DEFAULT 'custom',
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  radius_meters real NOT NULL DEFAULT 100,
  icon text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_favorite_places_user ON favorite_places (user_id);

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON blocked_users (blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users (blocked_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_requests boolean NOT NULL DEFAULT true,
  reactions boolean NOT NULL DEFAULT true,
  chat_messages boolean NOT NULL DEFAULT true,
  bumps boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friend_streaks (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  last_interaction_date date NOT NULL DEFAULT current_date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_streaks_user ON friend_streaks (user_id);

CREATE TABLE IF NOT EXISTS visited_cells (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  geohash text NOT NULL,
  first_visited_at timestamptz NOT NULL DEFAULT now(),
  last_visited_at timestamptz NOT NULL DEFAULT now(),
  visit_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, geohash)
);
CREATE INDEX IF NOT EXISTS idx_visited_cells_user ON visited_cells (user_id);
CREATE INDEX IF NOT EXISTS idx_visited_cells_geohash ON visited_cells (geohash);

-- =====================
-- Missing view
-- =====================
CREATE OR REPLACE VIEW visited_cell_stats AS
SELECT
  user_id,
  count(*) AS total_cells,
  min(first_visited_at) AS exploring_since,
  max(last_visited_at) AS last_explored_at
FROM visited_cells
GROUP BY user_id;

-- =====================
-- Missing functions
-- =====================
CREATE OR REPLACE FUNCTION cleanup_expired_share_rules()
RETURNS void AS $$
BEGIN
  DELETE FROM share_rules
  WHERE expires_at IS NOT NULL AND expires_at <= now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION record_interaction(p_user_id uuid, p_friend_id uuid)
RETURNS void AS $$
DECLARE
  v_last_date date;
  v_streak integer;
  v_longest integer;
BEGIN
  SELECT last_interaction_date, current_streak, longest_streak
  INTO v_last_date, v_streak, v_longest
  FROM friend_streaks
  WHERE user_id = p_user_id AND friend_id = p_friend_id;

  IF NOT FOUND THEN
    INSERT INTO friend_streaks (user_id, friend_id, current_streak, longest_streak, last_interaction_date)
    VALUES (p_user_id, p_friend_id, 1, 1, current_date);
    RETURN;
  END IF;

  IF v_last_date = current_date THEN RETURN; END IF;

  IF v_last_date = current_date - 1 THEN
    v_streak := v_streak + 1;
  ELSE
    v_streak := 1;
  END IF;

  v_longest := greatest(v_longest, v_streak);

  UPDATE friend_streaks
  SET current_streak = v_streak, longest_streak = v_longest,
      last_interaction_date = current_date, updated_at = now()
  WHERE user_id = p_user_id AND friend_id = p_friend_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_friends_of_friends(current_user_id uuid)
RETURNS TABLE(user_id uuid, mutual_friend_id uuid) AS $$
  WITH my_friends AS (
    SELECT CASE WHEN from_user_id = current_user_id THEN to_user_id ELSE from_user_id END AS friend_id
    FROM friend_requests
    WHERE status = 'accepted'
      AND (from_user_id = current_user_id OR to_user_id = current_user_id)
  ),
  fof AS (
    SELECT CASE WHEN fr.from_user_id = mf.friend_id THEN fr.to_user_id ELSE fr.from_user_id END AS fof_id,
           mf.friend_id AS mutual_friend_id
    FROM friend_requests fr
    JOIN my_friends mf ON (fr.from_user_id = mf.friend_id OR fr.to_user_id = mf.friend_id)
    WHERE fr.status = 'accepted'
  )
  SELECT fof_id AS user_id, mutual_friend_id
  FROM fof
  WHERE fof_id != current_user_id
    AND fof_id NOT IN (SELECT friend_id FROM my_friends);
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION encode_geohash(lat double precision, lon double precision, precision_len integer DEFAULT 7)
RETURNS text AS $$
DECLARE
  base32 text := '0123456789bcdefghjkmnpqrstuvwxyz';
  min_lat double precision := -90;
  max_lat double precision := 90;
  min_lon double precision := -180;
  max_lon double precision := 180;
  mid double precision;
  bits integer := 0;
  hash_val integer := 0;
  is_lon boolean := true;
  result text := '';
BEGIN
  WHILE length(result) < precision_len LOOP
    IF is_lon THEN
      mid := (min_lon + max_lon) / 2;
      IF lon >= mid THEN
        hash_val := hash_val * 2 + 1;
        min_lon := mid;
      ELSE
        hash_val := hash_val * 2;
        max_lon := mid;
      END IF;
    ELSE
      mid := (min_lat + max_lat) / 2;
      IF lat >= mid THEN
        hash_val := hash_val * 2 + 1;
        min_lat := mid;
      ELSE
        hash_val := hash_val * 2;
        max_lat := mid;
      END IF;
    END IF;
    is_lon := NOT is_lon;
    bits := bits + 1;
    IF bits = 5 THEN
      result := result || substr(base32, hash_val + 1, 1);
      bits := 0;
      hash_val := 0;
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION get_area_rankings(
  area_prefix text,
  result_limit integer DEFAULT 20
)
RETURNS TABLE(user_id uuid, cell_count bigint, rank bigint) AS $$
  SELECT
    v.user_id,
    count(*) AS cell_count,
    rank() OVER (ORDER BY count(*) DESC) AS rank
  FROM visited_cells v
  WHERE v.geohash LIKE area_prefix || '%'
  GROUP BY v.user_id
  ORDER BY cell_count DESC
  LIMIT result_limit;
$$ LANGUAGE sql SECURITY DEFINER;

-- =====================
-- Missing trigger
-- =====================
CREATE OR REPLACE FUNCTION record_visited_cell()
RETURNS trigger AS $$
DECLARE
  gh text;
BEGIN
  gh := encode_geohash(NEW.lat, NEW.lon, 7);
  INSERT INTO visited_cells (user_id, geohash, first_visited_at, last_visited_at, visit_count)
  VALUES (NEW.user_id, gh, now(), now(), 1)
  ON CONFLICT (user_id, geohash) DO UPDATE
  SET last_visited_at = now(), visit_count = visited_cells.visit_count + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_record_visited_cell ON locations_current;
CREATE TRIGGER trg_record_visited_cell
AFTER INSERT OR UPDATE ON locations_current
FOR EACH ROW EXECUTE FUNCTION record_visited_cell();

-- =====================
-- Missing RLS policies for new tables
-- =====================
ALTER TABLE favorite_places ENABLE ROW LEVEL SECURITY;

CREATE POLICY "favorite_places_select_own" ON favorite_places FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "favorite_places_select_friends" ON favorite_places FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM friend_requests
    WHERE status = 'accepted'
      AND ((from_user_id = auth.uid() AND to_user_id = favorite_places.user_id)
        OR (to_user_id = auth.uid() AND from_user_id = favorite_places.user_id))
  )
);
CREATE POLICY "favorite_places_insert" ON favorite_places FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "favorite_places_update" ON favorite_places FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "favorite_places_delete" ON favorite_places FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "blocked_users_select_own" ON blocked_users FOR SELECT USING (auth.uid() = blocker_id);
CREATE POLICY "blocked_users_insert_own" ON blocked_users FOR INSERT WITH CHECK (auth.uid() = blocker_id);
CREATE POLICY "blocked_users_delete_own" ON blocked_users FOR DELETE USING (auth.uid() = blocker_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push_subscriptions_select_own" ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "push_subscriptions_insert_own" ON push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "push_subscriptions_delete_own" ON push_subscriptions FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_prefs_select_own" ON notification_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "notification_prefs_insert_own" ON notification_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notification_prefs_update_own" ON notification_preferences FOR UPDATE USING (auth.uid() = user_id);

ALTER TABLE friend_streaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "friend_streaks_select" ON friend_streaks FOR SELECT USING (auth.uid() = user_id OR auth.uid() = friend_id);
CREATE POLICY "friend_streaks_insert_own" ON friend_streaks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "friend_streaks_update_own" ON friend_streaks FOR UPDATE USING (auth.uid() = user_id);

ALTER TABLE visited_cells ENABLE ROW LEVEL SECURITY;
CREATE POLICY "visited_cells_select_own" ON visited_cells FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "visited_cells_select_friends" ON visited_cells FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM friend_requests
    WHERE status = 'accepted'
      AND ((from_user_id = auth.uid() AND to_user_id = visited_cells.user_id)
        OR (to_user_id = auth.uid() AND from_user_id = visited_cells.user_id))
  )
);
CREATE POLICY "visited_cells_insert_own" ON visited_cells FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "visited_cells_update_own" ON visited_cells FOR UPDATE USING (auth.uid() = user_id);
