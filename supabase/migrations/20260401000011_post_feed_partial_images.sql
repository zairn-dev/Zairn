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
      when vc.viewer_tier in ('full', 'partial') then vc.image_url
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
