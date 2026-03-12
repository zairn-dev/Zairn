
-- =====================
-- 共有期限の自動クリーンアップ
-- =====================
create or replace function cleanup_expired_share_rules()
returns void as $$
begin
  delete from share_rules
  where expires_at is not null and expires_at <= now();
end;
$$ language plpgsql security definer;

-- pg_cronが有効な環境で実行:
-- select cron.schedule('cleanup-expired-share-rules', '*/15 * * * *', 'select cleanup_expired_share_rules()');

-- =====================
-- ストリーク記録関数
-- =====================
create or replace function record_interaction(p_user_id uuid, p_friend_id uuid)
returns void as $$
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
$$ language plpgsql security definer;

-- =====================
-- フレンドのフレンド取得関数
-- =====================
create or replace function get_friends_of_friends(current_user_id uuid)
returns table(user_id uuid, mutual_friend_id uuid) as $$
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
$$ language plpgsql security definer;

-- =====================
-- 訪問セル（エリア塗りつぶし）
-- =====================
-- Geohash precision 7 ≒ 約150m×150mセル
create table if not exists visited_cells (
  user_id uuid not null references auth.users(id) on delete cascade,
  geohash text not null,
  first_visited_at timestamptz not null default now(),
  last_visited_at timestamptz not null default now(),
  visit_count integer not null default 1,
  primary key (user_id, geohash)
);

create index if not exists idx_visited_cells_user on visited_cells (user_id);
create index if not exists idx_visited_cells_geohash on visited_cells (geohash);

-- 訪問セル集計ビュー（ランキング用）
-- security_barrier prevents leaking data through predicate pushdown
create or replace view visited_cell_stats with (security_barrier = true) as
select
  user_id,
  count(*) as total_cells,
  min(first_visited_at) as exploring_since,
  max(last_visited_at) as last_explored_at
from visited_cells
group by user_id;

-- エリア別（geohash prefix）集計関数
-- prefix_len: 4=約40km, 5=約5km, 6=約1.2km
-- Only returns rankings for the caller and their friends
create or replace function get_area_rankings(
  area_prefix text,
  result_limit integer default 20
)
returns table(user_id uuid, cell_count bigint, rank bigint) as $$
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
$$ language plpgsql security definer;

-- Geohashエンコード関数（DB側で位置→geohashを計算）
create or replace function encode_geohash(lat double precision, lon double precision, precision_len integer default 7)
returns text as $$
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
$$ language plpgsql immutable;

-- 位置送信時にセルを自動記録するトリガー
create or replace function record_visited_cell()
returns trigger as $$
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
$$ language plpgsql security definer;

create or replace trigger trg_record_visited_cell
after insert or update on locations_current
for each row execute function record_visited_cell();

-- =====================
-- DM チャットルーム作成（アトミック、競合状態なし）
-- =====================
create or replace function create_direct_chat(p_other_user_id uuid)
returns uuid as $$
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
$$ language plpgsql security definer;

-- =====================
-- グループチャットルーム作成（アトミック、競合状態なし）
-- =====================
create or replace function create_group_chat(p_group_id uuid)
returns uuid as $$
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
$$ language plpgsql security definer;

-- =====================
-- グループ参加（invite_codeを検証してメンバー追加）
-- =====================
create or replace function join_group_by_invite(p_invite_code text)
returns uuid as $$
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
$$ language plpgsql security definer;

-- =====================
-- フレンドリクエスト承認（双方向share_rules作成）
-- =====================
-- RLSでは自分のowner_idのみINSERT可能なので、相手側のルールは
-- security definer関数で作成する
create or replace function accept_friend_request(p_request_id bigint)
returns void as $$
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
$$ language plpgsql security definer;

-- =====================
-- ゴーストモード制御トリガー
-- =====================
-- ゴーストモードが有効な場合、位置更新をサーバー側で拒否
create or replace function enforce_ghost_mode()
returns trigger as $$
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
$$ language plpgsql security definer;

create or replace trigger trg_enforce_ghost_mode
before insert or update on locations_current
for each row execute function enforce_ghost_mode();

-- =====================
-- グループ作成（アトミック: groups + group_members を同一トランザクションで処理）
-- =====================
create or replace function create_group_atomic(p_name text, p_description text, p_invite_code text)
returns uuid as $$
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
$$ language plpgsql security definer;

-- =====================
-- フレンド削除（アトミック: friend_requests + share_rules を同一トランザクションで処理）
-- =====================
create or replace function remove_friend(p_friend_id uuid)
returns void as $$
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
$$ language plpgsql security definer;

-- =====================
-- leave_group（原子的グループ退出 — オーナーチェック＋退出を単一トランザクション）
-- =====================
create or replace function leave_group(p_group_id uuid)
returns void as $$
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
$$ language plpgsql security definer;

-- =====================
-- block_user_atomic（原子的ブロック — ブロック＋フレンド解除を単一トランザクション）
-- =====================
create or replace function block_user_atomic(p_blocked_id uuid)
returns void as $$
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
$$ language plpgsql security definer;

-- =====================
-- Supabase Storageバケット（avatars）
-- =====================
-- Supabaseダッシュボードまたはマイグレーションで実行:
-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
