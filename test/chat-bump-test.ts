import { createLocationCore } from '../sdk/javascript/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

async function testChatBumpReactions() {
  console.log('=== チャット・リアクション・Bump テスト ===\n');

  // テストユーザー2人を作成
  const user1Email = `chat1-${Date.now()}@example.com`;
  const user2Email = `chat2-${Date.now()}@example.com`;
  const password = 'testpassword123';

  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });

  // User1のセットアップ
  console.log('1. ユーザー作成');
  const { data: user1Data } = await core1.supabase.auth.signUp({ email: user1Email, password });
  const user1Id = user1Data.user!.id;
  console.log(`   User1: ${user1Id.slice(0, 8)}...`);
  // 明示的にログイン
  await core1.supabase.auth.signInWithPassword({ email: user1Email, password });

  const { data: user2Data } = await core2.supabase.auth.signUp({ email: user2Email, password });
  const user2Id = user2Data.user!.id;
  console.log(`   User2: ${user2Id.slice(0, 8)}...`);
  // 明示的にログイン
  await core2.supabase.auth.signInWithPassword({ email: user2Email, password });

  // デバッグ：auth.uid()の確認
  const { data: sessionData } = await core1.supabase.auth.getSession();
  console.log(`   Session User1: ${sessionData.session?.user?.id?.slice(0, 8) ?? 'null'}...`);

  // 友達になる（リアクション送信に必要）
  console.log('\n2. 友達申請と承認');
  const request = await core1.sendFriendRequest(user2Id);
  await core2.acceptFriendRequest(request.id);
  console.log('   ✓ 友達になりました');

  // =====================
  // チャットテスト
  // =====================
  console.log('\n--- チャット機能 ---');

  console.log('3. ダイレクトチャット作成');
  const chatRoom = await core1.getOrCreateDirectChat(user2Id);
  console.log(`   ✓ ルームID: ${chatRoom.id.slice(0, 8)}..., type: ${chatRoom.type}`);

  console.log('4. メッセージ送信 (User1 → User2)');
  const msg1 = await core1.sendMessage(chatRoom.id, 'こんにちは！');
  console.log(`   ✓ メッセージID: ${msg1.id}, content: ${msg1.content}`);

  console.log('5. メッセージ送信 (User2 → User1)');
  const msg2 = await core2.sendMessage(chatRoom.id, 'やあ！元気？');
  console.log(`   ✓ メッセージID: ${msg2.id}, content: ${msg2.content}`);

  console.log('6. メッセージ取得');
  const messages = await core1.getMessages(chatRoom.id, { limit: 10 });
  console.log(`   ✓ 取得したメッセージ: ${messages.length}件`);

  console.log('7. 既読マーク');
  await core2.markAsRead(chatRoom.id);
  console.log('   ✓ User2が既読');

  console.log('8. チャットルーム一覧取得');
  const rooms = await core1.getChatRooms();
  console.log(`   ✓ User1のルーム数: ${rooms.length}`);

  // =====================
  // リアクションテスト
  // =====================
  console.log('\n--- リアクション機能 ---');

  console.log('9. リアクション送信 (User1 → User2)');
  const reaction = await core1.sendReaction(user2Id, '👋', '今どこ？');
  console.log(`   ✓ リアクションID: ${reaction.id}, emoji: ${reaction.emoji}`);

  console.log('10. 受信リアクション取得');
  const received = await core2.getReceivedReactions({ limit: 10 });
  console.log(`   ✓ User2の受信リアクション: ${received.length}件`);
  if (received.length > 0) {
    console.log(`      emoji: ${received[0].emoji}, message: ${received[0].message}`);
  }

  console.log('11. 送信リアクション取得');
  const sent = await core1.getSentReactions({ limit: 10 });
  console.log(`   ✓ User1の送信リアクション: ${sent.length}件`);

  // =====================
  // Bumpテスト
  // =====================
  console.log('\n--- Bump機能 ---');

  // User1とUser2の位置を近くに設定
  console.log('12. 位置情報設定（近くに配置）');
  await core1.sendLocation(35.6812, 139.7671, 10); // 東京駅
  await core2.sendLocation(35.6815, 139.7675, 10); // 東京駅の近く（約50m）
  console.log('   ✓ User1: 東京駅, User2: 東京駅の近く');

  console.log('13. 近くの友達を検索');
  const nearby = await core1.findNearbyFriends(35.6812, 139.7671, 500);
  console.log(`   ✓ 500m以内の友達: ${nearby.length}人`);
  if (nearby.length > 0) {
    console.log(`      User2: ${nearby[0].distance_meters}m`);
  }

  console.log('14. Bumpイベント記録');
  if (nearby.length > 0) {
    const bump = await core1.recordBump(nearby[0].user_id, nearby[0].distance_meters, 35.6812, 139.7671);
    console.log(`   ✓ BumpID: ${bump.id}, distance: ${bump.distance_meters}m`);
  }

  console.log('15. Bump履歴取得');
  const bumpHistory = await core1.getBumpHistory({ limit: 10 });
  console.log(`   ✓ Bump履歴: ${bumpHistory.length}件`);

  // 遠くに移動して再テスト
  console.log('\n16. User2が遠くに移動');
  await core2.sendLocation(35.6580, 139.7016, 10); // 渋谷駅
  const nearbyAfter = await core1.findNearbyFriends(35.6812, 139.7671, 500);
  console.log(`   ✓ 500m以内の友達: ${nearbyAfter.length}人`);

  console.log('\n=== 全テスト完了 ===');
}

testChatBumpReactions().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
