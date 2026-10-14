-- Reconcile databases created from early versions of migrations 0001–0012.
--
-- Migrations 0001–0012 were edited in place after the first deployment
-- applied them, so that deployment never received the later definitions
-- (security fixes, helper functions, triggers, constraints). Migration
-- 20261014000018 then failed on it ("function enforce_ghost_mode() does not
-- exist"). This file re-asserts the current definitions. Every statement is
-- idempotent: on a database built from the current migrations it changes
-- nothing (verified by dumping both and diffing).
--
-- It also fixes a defect present in every database built from these
-- migrations: the geo_drops ⇄ drop_shares policies referenced each other, so
-- any non-owner SELECT on geo_drops, drop_shares or drop_claims failed with
-- "infinite recursion detected in policy". The cycle is now broken through
-- two SECURITY DEFINER helpers that only answer for the calling user.
--
-- RLS impact (on an early-version database):
--   * dropped: share_rules_insert_for_friends (a friend could create share
--     rules on the owner's behalf), groups_read_by_invite (every group with an
--     invite code, including the code, was readable), profiles_read_public
--     (profiles readable without signing in)
--   * replaced: group/chat membership policies that allowed reading every
--     room and membership and joining any chat room; friend-request,
--     reaction, bump, location-history and visited-cell policies now match the
--     current definitions
--   * rows of locations_current / locations_history / share_rules that point
--     at deleted accounts are removed before the missing ON DELETE CASCADE
--     foreign keys are added (the cascade would have removed them)

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.locations_current add column if not exists heading real;
alter table public.locations_current add column if not exists altitude real;

-- ---------------------------------------------------------------------
-- 2. Constraints (orphaned rows of deleted accounts first)
-- ---------------------------------------------------------------------
delete from public.locations_current t where not exists (select 1 from auth.users u where u.id = t.user_id);
delete from public.locations_history t where not exists (select 1 from auth.users u where u.id = t.user_id);
delete from public.share_rules t where not exists (select 1 from auth.users u where u.id = t.owner_id)
   or not exists (select 1 from auth.users u where u.id = t.viewer_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations_current'::regclass and conname = 'locations_current_user_id_fkey') then
    alter table public.locations_current add constraint locations_current_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.share_rules'::regclass and conname = 'share_rules_owner_id_fkey') then
    alter table public.share_rules add constraint share_rules_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.share_rules'::regclass and conname = 'share_rules_viewer_id_fkey') then
    alter table public.share_rules add constraint share_rules_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations_history'::regclass and conname = 'locations_history_user_id_fkey') then
    alter table public.locations_history add constraint locations_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.friend_requests'::regclass and conname = 'friend_requests_check') then
    alter table public.friend_requests add constraint friend_requests_check CHECK ((from_user_id <> to_user_id));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.group_members'::regclass and conname = 'group_members_role_check') then
    alter table public.group_members add constraint group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text, 'admin'::text])));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.blocked_users'::regclass and conname = 'blocked_users_check') then
    alter table public.blocked_users add constraint blocked_users_check CHECK ((blocker_id <> blocked_id));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_share_rules_viewer ON public.share_rules USING btree (viewer_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_group ON public.chat_rooms USING btree (group_id);

-- ---------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_drops()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update geo_drops
  set status = 'expired', updated_at = now()
  where status = 'active'
    and expires_at is not null
    and expires_at <= now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_claim_count(p_drop_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = greatest(claim_count - 1, 0), updated_at = now()
  where id = p_drop_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.protect_claim_count()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Allow if called from increment_claim_count (session variable set by that function)
  -- or if claim_count hasn't changed
  if NEW.claim_count != OLD.claim_count then
    -- Only allow if called from increment/decrement_claim_count (session flag)
    if coalesce(current_setting('app.claim_count_update', true), '') != 'true' then
      NEW.claim_count := OLD.claim_count; -- silently reset to old value
    end if;
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.remove_friend(p_friend_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Delete friend request
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_friend_id)
      or (from_user_id = p_friend_id and to_user_id = v_user_id));

  -- Delete both directions of share rules
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_friend_id)
     or (owner_id = p_friend_id and viewer_id = v_user_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_request_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_from_user_id uuid;
  v_to_user_id uuid;
begin
  -- 呼び出し元が to_user_id であることを確認
  update friend_requests
  set status = 'accepted', updated_at = now()
  where id = p_request_id
    and to_user_id = auth.uid()
    and status = 'pending'
  returning from_user_id, to_user_id into v_from_user_id, v_to_user_id;

  if v_from_user_id is null then
    raise exception 'Friend request not found or not authorized';
  end if;

  -- 双方向の共有ルールを作成（history レベル）
  insert into share_rules (owner_id, viewer_id, level)
  values
    (v_from_user_id, v_to_user_id, 'history'),
    (v_to_user_id, v_from_user_id, 'history')
  on conflict (owner_id, viewer_id) do update set level = 'history';
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ghost_mode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if exists (
    select 1 from user_settings
    where user_id = NEW.user_id
      and ghost_mode = true
      and (ghost_until is null or ghost_until > now())
  ) then
    raise exception 'Location update blocked: ghost mode is active';
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_atomic(p_name text, p_description text, p_invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into groups (name, description, owner_id, invite_code)
  values (p_name, p_description, auth.uid(), p_invite_code)
  returning id into v_group_id;

  insert into group_members (group_id, user_id, role)
  values (v_group_id, auth.uid(), 'owner');

  return v_group_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  select owner_id into v_owner_id from groups where id = p_group_id;
  if v_owner_id is null then
    raise exception 'Group not found';
  end if;
  if v_owner_id = v_user_id then
    raise exception 'Group owner cannot leave. Delete the group or transfer ownership first.';
  end if;
  delete from group_members where group_id = p_group_id and user_id = v_user_id;
  if not found then
    raise exception 'Not a member of this group';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.block_user_atomic(p_blocked_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_user_id = p_blocked_id then
    raise exception 'Cannot block yourself';
  end if;

  insert into blocked_users (blocker_id, blocked_id)
  values (v_user_id, p_blocked_id)
  on conflict do nothing;

  -- フレンド関係も解除
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_blocked_id)
      or (from_user_id = p_blocked_id and to_user_id = v_user_id));

  -- 共有ルールも削除
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_blocked_id)
     or (owner_id = p_blocked_id and viewer_id = v_user_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_chat_room_member(p_room_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select exists (
    select 1 from chat_room_members
    where room_id = p_room_id and user_id = p_user_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.protect_friend_request_ids()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if NEW.from_user_id != OLD.from_user_id then
    raise exception 'Cannot change from_user_id';
  end if;
  if NEW.to_user_id != OLD.to_user_id then
    raise exception 'Cannot change to_user_id';
  end if;
  -- accepted状態からのステータス変更は security definer (remove_friend) 経由のみ
  if OLD.status = 'accepted' and NEW.status != 'accepted' then
    raise exception 'Cannot change status of accepted friend request directly';
  end if;
  -- rejected状態からpendingへの巻き戻しを防止
  if OLD.status = 'rejected' and NEW.status = 'pending' then
    raise exception 'Cannot reactivate a rejected friend request';
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_share_rules()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  delete from share_rules
  where expires_at is not null and expires_at <= now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_interaction(p_user_id uuid, p_friend_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_last_date date;
  v_streak integer;
  v_longest integer;
begin
  -- Only allow recording interactions for the authenticated user
  if auth.uid() is null or auth.uid() != p_user_id then
    raise exception 'Can only record interactions for yourself';
  end if;

  -- Verify users are friends
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = p_user_id and to_user_id = p_friend_id)
        or (to_user_id = p_user_id and from_user_id = p_friend_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  select last_interaction_date, current_streak, longest_streak
  into v_last_date, v_streak, v_longest
  from friend_streaks
  where user_id = p_user_id and friend_id = p_friend_id
  for update;

  if not found then
    insert into friend_streaks (user_id, friend_id, current_streak, longest_streak, last_interaction_date)
    values (p_user_id, p_friend_id, 1, 1, current_date);
    return;
  end if;

  if v_last_date = current_date then return; end if;

  if v_last_date = current_date - 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;

  v_longest := greatest(v_longest, v_streak);

  update friend_streaks
  set current_streak = v_streak, longest_streak = v_longest,
      last_interaction_date = current_date, updated_at = now()
  where user_id = p_user_id and friend_id = p_friend_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_friends_of_friends(current_user_id uuid)
 RETURNS TABLE(user_id uuid, mutual_friend_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null or auth.uid() != current_user_id then
    raise exception 'Can only query own friends-of-friends';
  end if;

  return query
  with my_friends as (
    select case when fr.from_user_id = current_user_id then fr.to_user_id else fr.from_user_id end as friend_id
    from friend_requests fr
    where fr.status = 'accepted'
      and (fr.from_user_id = current_user_id or fr.to_user_id = current_user_id)
  ),
  fof as (
    select case when fr2.from_user_id = mf.friend_id then fr2.to_user_id else fr2.from_user_id end as fof_id,
           mf.friend_id as via_friend_id
    from friend_requests fr2
    join my_friends mf on (fr2.from_user_id = mf.friend_id or fr2.to_user_id = mf.friend_id)
    where fr2.status = 'accepted'
  )
  select fof.fof_id as user_id, fof.via_friend_id as mutual_friend_id
  from fof
  where fof.fof_id != current_user_id
    and fof.fof_id not in (select mf2.friend_id from my_friends mf2);
end;
$function$;

drop function if exists public.increment_claim_count(uuid);
CREATE OR REPLACE FUNCTION public.increment_claim_count(p_drop_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_max_claims integer;
  v_claim_count integer;
  updated_rows integer;
begin
  -- Require authentication
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Lock the drop row to prevent TOCTOU race condition
  select max_claims, claim_count into v_max_claims, v_claim_count
  from geo_drops
  where id = p_drop_id
  for update;

  if not found then
    raise exception 'Drop not found';
  end if;

  -- Check max claims under lock
  if v_max_claims is not null and v_claim_count >= v_max_claims then
    return false;
  end if;

  -- Prevent double-claim (checked under the row lock)
  if exists (select 1 from drop_claims where drop_id = p_drop_id and user_id = auth.uid()) then
    raise exception 'Already claimed';
  end if;

  -- Set session flag so protect_claim_count trigger allows the change
  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = claim_count + 1, updated_at = now()
  where id = p_drop_id;
  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_area_rankings(area_prefix text, result_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, cell_count bigint, rank bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Validate geohash prefix (only base32 chars, prevent LIKE injection)
  if area_prefix !~ '^[0-9bcdefghjkmnpqrstuvwxyz]+$' then
    raise exception 'Invalid geohash prefix';
  end if;

  -- 短すぎるprefixは大量行スキャンを引き起こすため拒否
  if length(area_prefix) < 2 then
    raise exception 'Geohash prefix too short (min 2 characters)';
  end if;

  return query
  select
    v.user_id,
    count(*) as cell_count,
    rank() over (order by count(*) desc) as rank
  from visited_cells v
  where v.geohash like area_prefix || '%'
    and (
      v.user_id = auth.uid()
      or exists (
        select 1 from friend_requests fr
        where fr.status = 'accepted'
          and ((fr.from_user_id = auth.uid() and fr.to_user_id = v.user_id)
            or (fr.to_user_id = auth.uid() and fr.from_user_id = v.user_id))
      )
    )
  group by v.user_id
  order by cell_count desc
  limit result_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.encode_geohash(lat double precision, lon double precision, precision_len integer DEFAULT 7)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
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
begin
  precision_len := least(precision_len, 12);
  while length(result) < precision_len loop
    if is_lon then
      mid := (min_lon + max_lon) / 2;
      if lon >= mid then
        hash_val := hash_val * 2 + 1;
        min_lon := mid;
      else
        hash_val := hash_val * 2;
        max_lon := mid;
      end if;
    else
      mid := (min_lat + max_lat) / 2;
      if lat >= mid then
        hash_val := hash_val * 2 + 1;
        min_lat := mid;
      else
        hash_val := hash_val * 2;
        max_lat := mid;
      end if;
    end if;
    is_lon := not is_lon;
    bits := bits + 1;
    if bits = 5 then
      result := result || substr(base32, hash_val + 1, 1);
      bits := 0;
      hash_val := 0;
    end if;
  end loop;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_visited_cell()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  gh text;
begin
  gh := encode_geohash(NEW.lat, NEW.lon, 7);
  insert into visited_cells (user_id, geohash, first_visited_at, last_visited_at, visit_count)
  values (NEW.user_id, gh, now(), now(), 1)
  on conflict (user_id, geohash) do update
  set last_visited_at = now(), visit_count = visited_cells.visit_count + 1;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_direct_chat(p_other_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
begin
  -- ブロックチェック
  if exists (
    select 1 from blocked_users
    where (blocker_id = v_user_id and blocked_id = p_other_user_id)
       or (blocker_id = p_other_user_id and blocked_id = v_user_id)
  ) then
    raise exception 'Cannot create chat with blocked user';
  end if;

  -- フレンドチェック
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = v_user_id and to_user_id = p_other_user_id)
        or (to_user_id = v_user_id and from_user_id = p_other_user_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  -- Advisory lock to prevent concurrent duplicate DM room creation
  -- Use a deterministic lock key from both user IDs (order-independent)
  perform pg_advisory_xact_lock(
    hashtext(least(v_user_id::text, p_other_user_id::text) || ':' || greatest(v_user_id::text, p_other_user_id::text))
  );

  -- 既存のDMルームを検索
  select cm1.room_id into v_room_id
  from chat_room_members cm1
  join chat_room_members cm2 on cm1.room_id = cm2.room_id
  join chat_rooms cr on cr.id = cm1.room_id
  where cm1.user_id = v_user_id
    and cm2.user_id = p_other_user_id
    and cr.type = 'direct'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成 + 両メンバー追加をアトミックに実行
  insert into chat_rooms (type) values ('direct')
  returning id into v_room_id;

  insert into chat_room_members (room_id, user_id)
  values (v_room_id, v_user_id), (v_room_id, p_other_user_id);

  return v_room_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_chat(p_group_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_room_id uuid;
begin
  -- メンバーチェック
  if not exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  ) then
    raise exception 'Not a member of this group';
  end if;

  -- Advisory lock to prevent concurrent duplicate group chat creation
  perform pg_advisory_xact_lock(hashtext('group_chat:' || p_group_id::text));

  -- 既存のグループチャットルームを検索
  select id into v_room_id
  from chat_rooms
  where group_id = p_group_id and type = 'group'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成
  insert into chat_rooms (type, group_id) values ('group', p_group_id)
  returning id into v_room_id;

  return v_room_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.join_group_by_invite(p_invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
begin
  select id into v_group_id from groups where invite_code = p_invite_code;
  if v_group_id is null then
    raise exception 'Invalid invite code';
  end if;

  -- ブロックチェック（グループオーナーがブロックしている場合は参加不可）
  if exists (
    select 1 from blocked_users bu
    join groups g on g.id = v_group_id
    where (bu.blocker_id = g.owner_id and bu.blocked_id = auth.uid())
       or (bu.blocker_id = auth.uid() and bu.blocked_id = g.owner_id)
  ) then
    raise exception 'Cannot join this group';
  end if;

  -- 既にメンバーなら何もしない
  if exists (select 1 from group_members where group_id = v_group_id and user_id = auth.uid()) then
    return v_group_id;
  end if;

  insert into group_members (group_id, user_id, role, joined_at)
  values (v_group_id, auth.uid(), 'member', now());

  return v_group_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------
drop trigger if exists trg_protect_friend_request_ids on public.friend_requests;
CREATE TRIGGER trg_protect_friend_request_ids BEFORE UPDATE ON public.friend_requests FOR EACH ROW EXECUTE FUNCTION public.protect_friend_request_ids();
drop trigger if exists trg_enforce_ghost_mode on public.locations_current;
CREATE TRIGGER trg_enforce_ghost_mode BEFORE INSERT OR UPDATE ON public.locations_current FOR EACH ROW EXECUTE FUNCTION public.enforce_ghost_mode();
drop trigger if exists trg_protect_claim_count on public.geo_drops;
CREATE TRIGGER trg_protect_claim_count BEFORE UPDATE ON public.geo_drops FOR EACH ROW EXECUTE FUNCTION public.protect_claim_count();
drop trigger if exists trg_protect_drop_sensitive_columns on public.geo_drops;
CREATE TRIGGER trg_protect_drop_sensitive_columns BEFORE UPDATE ON public.geo_drops FOR EACH ROW EXECUTE FUNCTION public.protect_drop_sensitive_columns();

-- ---------------------------------------------------------------------
-- 6. Policies
-- ---------------------------------------------------------------------
drop policy if exists groups_read_by_invite on public.groups;
drop policy if exists profiles_read_public on public.profiles;
drop policy if exists share_rules_insert_for_friends on public.share_rules;
drop policy if exists read_visible_locations on public.locations_current;
create policy read_visible_locations on public.locations_current as permissive for select to public
  using (((auth.uid() = user_id) OR ((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = locations_current.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = ANY (ARRAY['current'::public.share_level, 'history'::public.share_level])) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = locations_current.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = locations_current.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.user_settings
  WHERE ((user_settings.user_id = locations_current.user_id) AND (user_settings.ghost_mode = true) AND ((user_settings.ghost_until IS NULL) OR (user_settings.ghost_until > now())))))))));
drop policy if exists delete_own_location on public.locations_current;
create policy delete_own_location on public.locations_current as permissive for delete to public
  using ((auth.uid() = user_id));
drop policy if exists delete_own_history on public.locations_history;
create policy delete_own_history on public.locations_history as permissive for delete to public
  using ((auth.uid() = user_id));
drop policy if exists read_history_when_allowed on public.locations_history;
create policy read_history_when_allowed on public.locations_history as permissive for select to public
  using (((auth.uid() = user_id) OR ((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = locations_history.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = 'history'::public.share_level) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = locations_history.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = locations_history.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.user_settings
  WHERE ((user_settings.user_id = locations_history.user_id) AND (user_settings.ghost_mode = true) AND ((user_settings.ghost_until IS NULL) OR (user_settings.ghost_until > now())))))))));
drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles as permissive for select to public
  using ((auth.uid() IS NOT NULL));
drop policy if exists friend_requests_insert on public.friend_requests;
create policy friend_requests_insert on public.friend_requests as permissive for insert to public
  with check (((auth.uid() = from_user_id) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = friend_requests.to_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = friend_requests.to_user_id))))))));
drop policy if exists friend_requests_update on public.friend_requests;
create policy friend_requests_update on public.friend_requests as permissive for update to public
  using ((auth.uid() = to_user_id))
  with check (((auth.uid() = to_user_id) AND (status = 'rejected'::public.friend_request_status)));
drop policy if exists groups_read_member on public.groups;
create policy groups_read_member on public.groups as permissive for select to public
  using (((auth.uid() = owner_id) OR public.is_group_member(id, auth.uid())));
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members as permissive for select to public
  using (public.is_group_member(group_id, auth.uid()));
drop policy if exists group_members_insert on public.group_members;
create policy group_members_insert on public.group_members as permissive for insert to public
  with check (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.groups g
  WHERE ((g.id = group_members.group_id) AND (g.owner_id = auth.uid()))))));
drop policy if exists chat_rooms_select on public.chat_rooms;
create policy chat_rooms_select on public.chat_rooms as permissive for select to public
  using ((public.is_chat_room_member(id, auth.uid()) OR ((type = 'group'::text) AND public.is_group_member(group_id, auth.uid()))));
drop policy if exists chat_rooms_insert on public.chat_rooms;
create policy chat_rooms_insert on public.chat_rooms as permissive for insert to public
  with check (false);
drop policy if exists chat_room_members_select on public.chat_room_members;
create policy chat_room_members_select on public.chat_room_members as permissive for select to public
  using (((user_id = auth.uid()) OR public.is_chat_room_member(room_id, auth.uid())));
drop policy if exists chat_room_members_insert on public.chat_room_members;
create policy chat_room_members_insert on public.chat_room_members as permissive for insert to public
  with check ((auth.uid() = user_id));
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages as permissive for select to public
  using (public.is_chat_room_member(room_id, auth.uid()));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages as permissive for insert to public
  with check (((auth.uid() = sender_id) AND public.is_chat_room_member(room_id, auth.uid())));
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages as permissive for update to public
  using ((auth.uid() = sender_id))
  with check ((auth.uid() = sender_id));
drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages as permissive for delete to public
  using ((auth.uid() = sender_id));
drop policy if exists location_reactions_insert on public.location_reactions;
create policy location_reactions_insert on public.location_reactions as permissive for insert to public
  with check (((auth.uid() = from_user_id) AND (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = location_reactions.to_user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = location_reactions.to_user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = location_reactions.to_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = location_reactions.to_user_id))))))));
drop policy if exists bump_events_insert on public.bump_events;
create policy bump_events_insert on public.bump_events as permissive for insert to public
  with check (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = bump_events.nearby_user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = bump_events.nearby_user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = bump_events.nearby_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = bump_events.nearby_user_id))))))));
drop policy if exists favorite_places_select_friends on public.favorite_places;
create policy favorite_places_select_friends on public.favorite_places as permissive for select to public
  using (((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = favorite_places.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = ANY (ARRAY['current'::public.share_level, 'history'::public.share_level])) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = favorite_places.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = favorite_places.user_id))))))));
drop policy if exists blocked_users_select_own on public.blocked_users;
create policy blocked_users_select_own on public.blocked_users as permissive for select to public
  using (((auth.uid() = blocker_id) OR (auth.uid() = blocked_id)));
drop policy if exists friend_streaks_select on public.friend_streaks;
create policy friend_streaks_select on public.friend_streaks as permissive for select to public
  using ((auth.uid() = user_id));
drop policy if exists visited_cells_select_friends on public.visited_cells;
create policy visited_cells_select_friends on public.visited_cells as permissive for select to public
  using (((EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = visited_cells.user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = visited_cells.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = visited_cells.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = visited_cells.user_id))))))));
drop policy if exists visited_cells_update_own on public.visited_cells;
create policy visited_cells_update_own on public.visited_cells as permissive for update to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
drop policy if exists geo_drops_select_friends on public.geo_drops;
create policy geo_drops_select_friends on public.geo_drops as permissive for select to public
  using (((visibility = 'friends'::public.drop_visibility) AND (status = 'active'::public.drop_status) AND ((expires_at IS NULL) OR (expires_at > now())) AND ((creator_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = geo_drops.creator_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = geo_drops.creator_id)))))))));
drop policy if exists geo_drops_update on public.geo_drops;
create policy geo_drops_update on public.geo_drops as permissive for update to public
  using ((auth.uid() = creator_id))
  with check ((auth.uid() = creator_id));
drop policy if exists drop_claims_insert on public.drop_claims;
create policy drop_claims_insert on public.drop_claims as permissive for insert to public
  with check (false);
-- ---------------------------------------------------------------------
-- 7. GeoDrop policy recursion. geo_drops (private) read drop_shares, whose
--    creator policies read geo_drops again. The helpers below run as the
--    owner, so the inner lookup skips RLS and the cycle is gone. They answer
--    only for the calling user, so they cannot be used to probe who created
--    or received a drop.
-- ---------------------------------------------------------------------
create or replace function public.is_drop_creator(p_drop_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p_user_id = auth.uid(), false)
     and exists (select 1 from geo_drops where id = p_drop_id and creator_id = p_user_id);
$$;

create or replace function public.is_drop_shared_with(p_drop_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p_user_id = auth.uid(), false)
     and exists (select 1 from drop_shares where drop_id = p_drop_id and user_id = p_user_id);
$$;

revoke all on function public.is_drop_creator(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_drop_shared_with(uuid, uuid) from public, anon, authenticated, service_role;
-- anon needs EXECUTE because these policies apply to every role.
grant execute on function public.is_drop_creator(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.is_drop_shared_with(uuid, uuid) to anon, authenticated, service_role;

drop policy if exists geo_drops_select_private_shared on public.geo_drops;
create policy geo_drops_select_private_shared on public.geo_drops
for select using (
  visibility = 'private'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and public.is_drop_shared_with(id, auth.uid())
);

drop policy if exists drop_shares_select_creator on public.drop_shares;
create policy drop_shares_select_creator on public.drop_shares
for select using (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_shares_insert on public.drop_shares;
create policy drop_shares_insert on public.drop_shares
for insert with check (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_shares_delete on public.drop_shares;
create policy drop_shares_delete on public.drop_shares
for delete using (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_claims_select_creator on public.drop_claims;
create policy drop_claims_select_creator on public.drop_claims
for select using (public.is_drop_creator(drop_id, auth.uid()));

-- Early deployments also had is_friend(a, b), callable by anyone, which
-- disclosed whether any two users are friends. Nothing uses it any more.
drop function if exists public.is_friend(uuid, uuid);
-- ---------------------------------------------------------------------
-- 8. View options
-- ---------------------------------------------------------------------
alter view public.visited_cell_stats set (security_barrier = true);

-- ---------------------------------------------------------------------
-- 9. Realtime publication as 20240101000007 defines it. Only adds missing
--    tables; a FOR ALL TABLES publication is left alone. A publication this
--    role cannot alter is reported instead of failing the migration.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['locations_current', 'friend_requests', 'messages', 'location_reactions', 'geo_drops'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
  alter publication supabase_realtime set (publish = 'insert, update, delete');
exception
  when insufficient_privilege then
    raise warning 'supabase_realtime publication not updated: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 10. Function privileges (as created by the current migrations)
-- ---------------------------------------------------------------------
revoke all on function public.decrement_claim_count(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.decrement_claim_count(uuid) to public;
grant EXECUTE on function public.decrement_claim_count(uuid) to anon;
grant EXECUTE on function public.decrement_claim_count(uuid) to authenticated;
grant EXECUTE on function public.decrement_claim_count(uuid) to service_role;
revoke all on function public.protect_claim_count() from public, anon, authenticated, service_role;
grant EXECUTE on function public.protect_claim_count() to public;
grant EXECUTE on function public.protect_claim_count() to anon;
grant EXECUTE on function public.protect_claim_count() to authenticated;
grant EXECUTE on function public.protect_claim_count() to service_role;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.remove_friend(uuid) to public;
grant EXECUTE on function public.remove_friend(uuid) to anon;
grant EXECUTE on function public.remove_friend(uuid) to authenticated;
grant EXECUTE on function public.remove_friend(uuid) to service_role;
revoke all on function public.accept_friend_request(bigint) from public, anon, authenticated, service_role;
grant EXECUTE on function public.accept_friend_request(bigint) to public;
grant EXECUTE on function public.accept_friend_request(bigint) to anon;
grant EXECUTE on function public.accept_friend_request(bigint) to authenticated;
grant EXECUTE on function public.accept_friend_request(bigint) to service_role;
revoke all on function public.enforce_ghost_mode() from public, anon, authenticated, service_role;
grant EXECUTE on function public.enforce_ghost_mode() to public;
grant EXECUTE on function public.enforce_ghost_mode() to anon;
grant EXECUTE on function public.enforce_ghost_mode() to authenticated;
grant EXECUTE on function public.enforce_ghost_mode() to service_role;
revoke all on function public.create_group_atomic(text,text,text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_group_atomic(text,text,text) to public;
grant EXECUTE on function public.create_group_atomic(text,text,text) to anon;
grant EXECUTE on function public.create_group_atomic(text,text,text) to authenticated;
grant EXECUTE on function public.create_group_atomic(text,text,text) to service_role;
revoke all on function public.leave_group(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.leave_group(uuid) to public;
grant EXECUTE on function public.leave_group(uuid) to anon;
grant EXECUTE on function public.leave_group(uuid) to authenticated;
grant EXECUTE on function public.leave_group(uuid) to service_role;
revoke all on function public.block_user_atomic(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.block_user_atomic(uuid) to public;
grant EXECUTE on function public.block_user_atomic(uuid) to anon;
grant EXECUTE on function public.block_user_atomic(uuid) to authenticated;
grant EXECUTE on function public.block_user_atomic(uuid) to service_role;
revoke all on function public.is_group_member(uuid,uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_group_member(uuid,uuid) to public;
grant EXECUTE on function public.is_group_member(uuid,uuid) to anon;
grant EXECUTE on function public.is_group_member(uuid,uuid) to authenticated;
grant EXECUTE on function public.is_group_member(uuid,uuid) to service_role;
revoke all on function public.is_chat_room_member(uuid,uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to public;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to anon;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to authenticated;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to service_role;
revoke all on function public.protect_friend_request_ids() from public, anon, authenticated, service_role;
grant EXECUTE on function public.protect_friend_request_ids() to public;
grant EXECUTE on function public.protect_friend_request_ids() to anon;
grant EXECUTE on function public.protect_friend_request_ids() to authenticated;
grant EXECUTE on function public.protect_friend_request_ids() to service_role;
revoke all on function public.increment_claim_count(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.increment_claim_count(uuid) to public;
grant EXECUTE on function public.increment_claim_count(uuid) to anon;
grant EXECUTE on function public.increment_claim_count(uuid) to authenticated;
grant EXECUTE on function public.increment_claim_count(uuid) to service_role;
revoke all on function public.create_direct_chat(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_direct_chat(uuid) to public;
grant EXECUTE on function public.create_direct_chat(uuid) to anon;
grant EXECUTE on function public.create_direct_chat(uuid) to authenticated;
grant EXECUTE on function public.create_direct_chat(uuid) to service_role;
revoke all on function public.create_group_chat(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_group_chat(uuid) to public;
grant EXECUTE on function public.create_group_chat(uuid) to anon;
grant EXECUTE on function public.create_group_chat(uuid) to authenticated;
grant EXECUTE on function public.create_group_chat(uuid) to service_role;
revoke all on function public.join_group_by_invite(text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.join_group_by_invite(text) to public;
grant EXECUTE on function public.join_group_by_invite(text) to anon;
grant EXECUTE on function public.join_group_by_invite(text) to authenticated;
grant EXECUTE on function public.join_group_by_invite(text) to service_role;
