insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_read_public'
  ) then
    create policy post_images_read_public
      on storage.objects
      for select
      using (bucket_id = 'post-images');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_insert_own'
  ) then
    create policy post_images_insert_own
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_update_own'
  ) then
    create policy post_images_update_own
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_delete_own'
  ) then
    create policy post_images_delete_own
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;
end
$$;
