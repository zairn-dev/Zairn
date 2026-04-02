create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  text text,
  image_url text,
  visibility_value integer not null default 50,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (visibility_value >= 0 and visibility_value <= 100),
  check (coalesce(length(trim(text)), 0) > 0 or image_url is not null)
);

create index if not exists idx_posts_author_created
  on posts (author_id, created_at desc);

create index if not exists idx_posts_expires_at
  on posts (expires_at);

alter table posts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_select_own'
  ) then
    create policy posts_select_own
      on posts
      for select
      to authenticated
      using (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_insert_own'
  ) then
    create policy posts_insert_own
      on posts
      for insert
      to authenticated
      with check (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_update_own'
  ) then
    create policy posts_update_own
      on posts
      for update
      to authenticated
      using (author_id = auth.uid())
      with check (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_delete_own'
  ) then
    create policy posts_delete_own
      on posts
      for delete
      to authenticated
      using (author_id = auth.uid());
  end if;
end
$$;

grant select, insert, update, delete
  on posts
  to authenticated;

create or replace function get_post_feed(p_limit integer default 50)
returns table (
  post_id uuid,
  author_id uuid,
  author_username text,
  author_display_name text,
  text text,
  image_url text,
  visibility_value integer,
  expires_at timestamptz,
  created_at timestamptz,
  viewer_tier text,
  is_author boolean
) as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with visible_candidates as (
    select
      p.id,
      p.author_id,
      pr.username as author_username,
      pr.display_name as author_display_name,
      p.text,
      p.image_url,
      p.visibility_value,
      p.expires_at,
      p.created_at,
      (p.author_id = v_user_id) as is_author,
      case
        when p.author_id = v_user_id then 'full'
        when fr.id is not null then
          case
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 100 - p.visibility_value)
              then 'full'
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 70 - p.visibility_value)
              then 'partial'
            else 'hidden'
          end
        else null
      end as viewer_tier
    from posts p
    left join profiles pr
      on pr.user_id = p.author_id
    left join friend_requests fr
      on fr.status = 'accepted'
      and (
        (fr.from_user_id = p.author_id and fr.to_user_id = v_user_id)
        or (fr.to_user_id = p.author_id and fr.from_user_id = v_user_id)
      )
    left join relationship_settings rs
      on rs.owner_id = p.author_id
      and rs.target_id = v_user_id
    where p.deleted_at is null
      and p.expires_at > now()
  )
  select
    vc.id as post_id,
    vc.author_id,
    vc.author_username,
    vc.author_display_name,
    case vc.viewer_tier
      when 'full' then vc.text
      when 'partial' then
        case
          when vc.text is null then null
          when length(vc.text) <= 80 then vc.text
          else left(vc.text, 80) || '...'
        end
      else null
    end as text,
    case
      when vc.viewer_tier = 'full' then vc.image_url
      else null
    end as image_url,
    vc.visibility_value,
    vc.expires_at,
    vc.created_at,
    vc.viewer_tier,
    vc.is_author
  from visible_candidates vc
  where vc.viewer_tier is not null
  order by vc.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function get_post_feed(integer)
  to authenticated;

grant execute on function get_post_feed(integer)
  to service_role;
