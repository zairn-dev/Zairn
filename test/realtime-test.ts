import { createClient } from '@supabase/supabase-js';
import { createLocationCore } from '../sdk/javascript/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

async function testRealtime() {
  console.log('=== Realtimeテスト ===\n');

  // 1. テストユーザー2人を作成
  const user1Email = `realtime1-${Date.now()}@example.com`;
  const user2Email = `realtime2-${Date.now()}@example.com`;
  const password = 'testpassword123';

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  console.log('1. テストユーザー作成');
  const { data: user1Data } = await supabase.auth.signUp({ email: user1Email, password });
  const user1Id = user1Data.user!.id;
  console.log(`   User1: ${user1Id}`);

  await supabase.auth.signOut();

  const { data: user2Data } = await supabase.auth.signUp({ email: user2Email, password });
  const user2Id = user2Data.user!.id;
  console.log(`   User2: ${user2Id}`);

  // 2. User1でログインして初期位置を送信
  console.log('\n2. User1の初期位置を送信');
  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  await core1.supabase.auth.signInWithPassword({ email: user1Email, password });
  await core1.sendLocation(35.6812, 139.7671, 10); // 東京駅
  console.log('   ✓ 初期位置送信完了');

  // 3. User1がUser2に閲覧許可を付与
  console.log('\n3. User1がUser2に閲覧許可を付与');
  await core1.allow(user2Id, 'current');
  console.log('   ✓ 許可付与完了');

  // 4. User2でログインしてRealtime購読を開始
  console.log('\n4. User2がRealtime購読を開始');
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  await core2.supabase.auth.signInWithPassword({ email: user2Email, password });

  let receivedUpdate = false;

  // SDKのsubscribeLocationsはUPDATEのみ購読するので、直接チャンネルを作成
  const channel = core2.supabase
    .channel('realtime-test')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'locations_current' },
      (payload) => {
        console.log(`   📍 イベント受信: ${payload.eventType}`);
        const row = payload.new as any;
        if (row && row.user_id) {
          console.log(`      user_id=${row.user_id.slice(0, 8)}... lat=${row.lat}, lon=${row.lon}`);
          if (row.user_id === user1Id) {
            receivedUpdate = true;
          }
        }
      }
    )
    .subscribe();

  // 購読が確立するまで少し待つ
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('   ✓ 購読開始');

  // 5. User1が位置を更新
  console.log('\n5. User1が位置を更新（渋谷駅へ移動）');
  await core1.sendLocation(35.6580, 139.7016, 15); // 渋谷駅
  console.log('   ✓ 位置更新送信');

  // 6. 更新を受信するまで待機（最大5秒）
  console.log('\n6. 更新受信を待機中...');
  const timeout = 5000;
  const start = Date.now();
  while (!receivedUpdate && Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (receivedUpdate) {
    console.log('   ✓ Realtime更新を受信しました！');
  } else {
    console.log('   ✗ タイムアウト: 更新を受信できませんでした');
    console.log('   → Supabaseダッシュボードで locations_current のReplicationが有効か確認してください');
  }

  // 7. クリーンアップ
  console.log('\n7. クリーンアップ');
  core2.supabase.removeChannel(channel);
  console.log('   ✓ 購読解除');

  console.log('\n=== テスト完了 ===');
  process.exit(0);
}

testRealtime().catch(console.error);
