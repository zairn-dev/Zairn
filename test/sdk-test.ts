import { createClient } from '@supabase/supabase-js';
import { createLocationCore } from '../packages/sdk/src/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testSDK() {
  console.log('=== SDK動作テスト ===\n');

  // 1. テストユーザー2人を作成
  const user1Email = `user1-${Date.now()}@example.com`;
  const user2Email = `user2-${Date.now()}@example.com`;
  const password = 'testpassword123';

  console.log('1. テストユーザー作成');
  const { data: user1Data } = await supabase.auth.signUp({ email: user1Email, password });
  const user1Id = user1Data.user!.id;
  console.log(`   User1: ${user1Id}`);

  await supabase.auth.signOut();

  const { data: user2Data } = await supabase.auth.signUp({ email: user2Email, password });
  const user2Id = user2Data.user!.id;
  console.log(`   User2: ${user2Id}`);

  // 2. User1でログインしてSDKを使用
  console.log('\n2. User1で位置情報送信');
  await supabase.auth.signInWithPassword({ email: user1Email, password });

  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  // 内部クライアントのセッションを同期
  await core1.supabase.auth.signInWithPassword({ email: user1Email, password });

  await core1.sendLocation(35.6812, 139.7671, 10); // 東京駅
  console.log('   ✓ User1の位置情報を送信 (東京駅: 35.6812, 139.7671)');

  // 3. User2でログインしてUser1の位置を見ようとする（許可なし）
  console.log('\n3. User2がUser1の位置を取得（許可なし）');
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  await core2.supabase.auth.signInWithPassword({ email: user2Email, password });

  const visibleBefore = await core2.getVisibleFriends();
  console.log(`   取得できた位置情報: ${visibleBefore.length}件`);
  if (visibleBefore.length === 0) {
    console.log('   ✓ RLSにより他者の位置は見えない（正常）');
  }

  // 4. User1がUser2に閲覧許可を与える
  console.log('\n4. User1がUser2に閲覧許可を付与');
  await core1.allow(user2Id, 'current');
  console.log('   ✓ 許可を付与');

  // 5. User2で再度取得
  console.log('\n5. User2がUser1の位置を取得（許可あり）');
  const visibleAfter = await core2.getVisibleFriends();
  console.log(`   取得できた位置情報: ${visibleAfter.length}件`);
  if (visibleAfter.length > 0) {
    const loc = visibleAfter.find(l => l.user_id === user1Id);
    if (loc) {
      console.log(`   ✓ User1の位置取得成功: lat=${loc.lat}, lon=${loc.lon}`);
    }
  }

  // 6. User1が許可を取り消し
  console.log('\n6. User1が許可を取り消し');
  await core1.revoke(user2Id);
  console.log('   ✓ 許可を取り消し');

  // 7. User2で再度取得（見えなくなるはず）
  console.log('\n7. User2がUser1の位置を取得（許可取り消し後）');
  const visibleRevoked = await core2.getVisibleFriends();
  const user1Visible = visibleRevoked.find(l => l.user_id === user1Id);
  if (!user1Visible) {
    console.log('   ✓ User1の位置は見えなくなった（正常）');
  } else {
    console.log('   ✗ まだUser1の位置が見える（問題あり）');
  }

  console.log('\n=== テスト完了 ===');
}

testSDK().catch(console.error);
