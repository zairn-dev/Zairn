create table if not exists relationship_settings (
  owner_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid not null references auth.users(id) on delete cascade,
  intimacy_score integer not null default 20,
  updated_at timestamptz not null default now(),
  primary key (owner_id, target_id),
  check (owner_id <> target_id),
  check (intimacy_score >= 0 and intimacy_score <= 100)
);

create index if not exists idx_relationship_settings_owner
  on relationship_settings (owner_id);

create index if not exists idx_relationship_settings_target
  on relationship_settings (target_id);

alter table relationship_settings enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_select_own'
  ) then
    create policy relationship_settings_select_own
      on relationship_settings
      for select
      to authenticated
      using (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_insert_own'
  ) then
    create policy relationship_settings_insert_own
      on relationship_settings
      for insert
      to authenticated
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_update_own'
  ) then
    create policy relationship_settings_update_own
      on relationship_settings
      for update
      to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_delete_own'
  ) then
    create policy relationship_settings_delete_own
      on relationship_settings
      for delete
      to authenticated
      using (owner_id = auth.uid());
  end if;
end
$$;

grant select, insert, update, delete
  on relationship_settings
  to authenticated;

insert into relationship_settings (owner_id, target_id, intimacy_score)
select from_user_id, to_user_id, 20
from friend_requests
where status = 'accepted'
on conflict (owner_id, target_id) do nothing;

insert into relationship_settings (owner_id, target_id, intimacy_score)
select to_user_id, from_user_id, 20
from friend_requests
where status = 'accepted'
on conflict (owner_id, target_id) do nothing;

create or replace function set_relationship_intimacy(
  p_target_id uuid,
  p_intimacy_score integer
)
returns void as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_target_id is null or p_target_id = v_user_id then
    raise exception 'Invalid target user';
  end if;

  if p_intimacy_score < 0 or p_intimacy_score > 100 then
    raise exception 'Intimacy score must be between 0 and 100';
  end if;

  if not exists (
    select 1
    from friend_requests
    where status = 'accepted'
      and (
        (from_user_id = v_user_id and to_user_id = p_target_id)
        or (from_user_id = p_target_id and to_user_id = v_user_id)
      )
  ) then
    raise exception 'Users are not connected';
  end if;

  insert into relationship_settings (
    owner_id,
    target_id,
    intimacy_score,
    updated_at
  )
  values (
    v_user_id,
    p_target_id,
    p_intimacy_score,
    now()
  )
  on conflict (owner_id, target_id) do update
    set intimacy_score = excluded.intimacy_score,
        updated_at = now();
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function set_relationship_intimacy(uuid, integer)
  to authenticated;

grant execute on function set_relationship_intimacy(uuid, integer)
  to service_role;
