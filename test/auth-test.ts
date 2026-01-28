import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// テスト用のランダムなメールアドレス生成
const testEmail = `test-${Date.now()}@example.com`;
const testPassword = 'testpassword123';

async function testAuth() {
  console.log('=== 認証テスト ===\n');

  // 1. サインアップ
  console.log(`1. サインアップテスト (${testEmail})`);
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: testEmail,
    password: testPassword,
  });

  if (signUpError) {
    console.log(`✗ サインアップエラー: ${signUpError.message}`);
    return;
  }
  console.log(`✓ サインアップ成功`);
  console.log(`  User ID: ${signUpData.user?.id}`);

  // 2. 現在のセッション確認
  console.log('\n2. セッション確認');
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    console.log(`✓ セッションあり`);
    console.log(`  User ID: ${sessionData.session.user.id}`);
  } else {
    console.log(`- セッションなし（メール確認が必要な設定の場合）`);
  }

  // 3. ログイン（メール確認不要の場合のみ動作）
  console.log('\n3. ログインテスト');
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  if (signInError) {
    console.log(`- ログインスキップ: ${signInError.message}`);
    console.log('  （メール確認が必要な設定です）');
  } else {
    console.log(`✓ ログイン成功`);
    console.log(`  User ID: ${signInData.user?.id}`);
  }

  // 4. ユーザー情報取得
  console.log('\n4. ユーザー情報取得');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) {
    console.log(`- ユーザー情報なし: ${userError.message}`);
  } else {
    console.log(`✓ ユーザー情報取得成功`);
    console.log(`  ID: ${userData.user?.id}`);
    console.log(`  Email: ${userData.user?.email}`);
  }

  // 5. ログアウト
  console.log('\n5. ログアウトテスト');
  const { error: signOutError } = await supabase.auth.signOut();
  if (signOutError) {
    console.log(`✗ ログアウトエラー: ${signOutError.message}`);
  } else {
    console.log(`✓ ログアウト成功`);
  }

  console.log('\n=== テスト完了 ===');
}

testAuth().catch(console.error);
