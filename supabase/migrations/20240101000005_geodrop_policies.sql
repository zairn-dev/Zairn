-- =====================
-- geo_drops ポリシー
-- =====================
alter table geo_drops enable row level security;

-- publicドロップは誰でも見える
create policy "geo_drops_select_public"
on geo_drops for select
using (
  visibility = 'public'
  and status = 'active'
  and (expires_at is null or expires_at > now())
);

-- friendsドロップはフレンドのみ
create policy "geo_drops_select_friends"
on geo_drops for select
using (
  visibility = 'friends'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and (
    creator_id = auth.uid()
    or exists (
      select 1 from friend_requests
      where status = 'accepted'
        and ((from_user_id = auth.uid() and to_user_id = geo_drops.creator_id)
          or (to_user_id = auth.uid() and from_user_id = geo_drops.creator_id))
    )
  )
);

-- 自分のドロップは常に見える（ステータス問わず）
create policy "geo_drops_select_own"
on geo_drops for select
using (creator_id = auth.uid());

-- パスワード付きドロップは誰でも見える（中身はパスワードで保護）
create policy "geo_drops_select_password"
on geo_drops for select
using (
  visibility = 'password'
  and status = 'active'
  and (expires_at is null or expires_at > now())
);

-- privateドロップは共有先ユーザーのみ
create policy "geo_drops_select_private_shared"
on geo_drops for select
using (
  visibility = 'private'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and exists (
    select 1 from drop_shares
    where drop_id = geo_drops.id
      and user_id = auth.uid()
  )
);

-- 作成は認証ユーザーのみ
create policy "geo_drops_insert"
on geo_drops for insert
with check (auth.uid() = creator_id);

-- 更新は作成者のみ（creator_id の変更も禁止）
create policy "geo_drops_update"
on geo_drops for update
using (auth.uid() = creator_id)
with check (auth.uid() = creator_id);

-- 削除は作成者のみ（論理削除推奨だが物理削除も許可）
create policy "geo_drops_delete"
on geo_drops for delete
using (auth.uid() = creator_id);

-- NOTE: RLSはカラムレベルの制限不可。センシティブカラム (encryption_salt,
-- password_hash, encrypted_content) はSDK側のSELECTでカラム指定して除外済み。
-- unlock-drop Edge FunctionはサービスロールでアクセスするためRLS非適用。

-- 更新時にセンシティブカラム・セキュリティカラムの不正変更を防止するトリガー
create or replace function protect_drop_sensitive_columns()
returns trigger as $$
begin
  -- creator_id は変更不可（所有権移転防止）
  if NEW.creator_id is distinct from OLD.creator_id then
    raise exception 'Cannot modify creator_id';
  end if;
  -- encryption_salt は変更不可
  if NEW.encryption_salt is distinct from OLD.encryption_salt then
    raise exception 'Cannot modify encryption_salt';
  end if;
  -- geohash は変更不可 (暗号化キーに使われる)
  if NEW.geohash is distinct from OLD.geohash then
    raise exception 'Cannot modify geohash';
  end if;
  return NEW;
end;
$$ language plpgsql;

create or replace trigger trg_protect_drop_sensitive_columns
before update on geo_drops
for each row execute function protect_drop_sensitive_columns();

-- =====================
-- drop_claims ポリシー
-- =====================
alter table drop_claims enable row level security;

-- 自分のクレームは見える
create policy "drop_claims_select_own"
on drop_claims for select
using (user_id = auth.uid());

-- ドロップ作成者はそのドロップのクレームが見える
create policy "drop_claims_select_creator"
on drop_claims for select
using (
  exists (
    select 1 from geo_drops
    where id = drop_claims.drop_id
      and creator_id = auth.uid()
  )
);

-- クレーム作成はEdge Function(service_role)経由のみ
-- 直接INSERTを禁止（距離検証はEdge Functionで行う）
create policy "drop_claims_insert"
on drop_claims for insert
with check (false);

-- =====================
-- drop_shares ポリシー
-- =====================
alter table drop_shares enable row level security;

-- 共有先ユーザーは自分の共有を見れる
create policy "drop_shares_select_shared"
on drop_shares for select
using (user_id = auth.uid());

-- ドロップ作成者は共有一覧を見れる
create policy "drop_shares_select_creator"
on drop_shares for select
using (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

-- 作成者のみ共有を追加・削除できる
create policy "drop_shares_insert"
on drop_shares for insert
with check (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

create policy "drop_shares_delete"
on drop_shares for delete
using (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

-- =====================
-- drop_location_logs ポリシー
-- =====================
alter table drop_location_logs enable row level security;

-- 自分のログのみ見える
create policy "drop_location_logs_select_own"
on drop_location_logs for select
using (auth.uid() = user_id);

-- ログ書き込みは認証ユーザーのみ
create policy "drop_location_logs_insert"
on drop_location_logs for insert
with check (auth.uid() = user_id);
