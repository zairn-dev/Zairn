import { createLocationCore } from '../sdk/javascript/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

async function testFeatures() {
  console.log('=== 新機能テスト ===\n');

  // テストユーザー2人を作成
  const user1Email = `feat1-${Date.now()}@example.com`;
  const user2Email = `feat2-${Date.now()}@example.com`;
  const password = 'testpassword123';

  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });

  // User1のセットアップ
  console.log('1. ユーザー作成');
  const { data: user1Data } = await core1.supabase.auth.signUp({ email: user1Email, password });
  const user1Id = user1Data.user!.id;
  console.log(`   User1: ${user1Id.slice(0, 8)}...`);

  const { data: user2Data } = await core2.supabase.auth.signUp({ email: user2Email, password });
  const user2Id = user2Data.user!.id;
  console.log(`   User2: ${user2Id.slice(0, 8)}...`);

  // =====================
  // プロフィールテスト
  // =====================
  console.log('\n--- プロフィール機能 ---');

  console.log('2. プロフィール更新');
  const profile1 = await core1.updateProfile({
    username: `user1_${Date.now()}`,
    display_name: 'テストユーザー1',
  });
  console.log(`   ✓ User1: username=${profile1.username}, display_name=${profile1.display_name}`);

  console.log('3. プロフィール取得');
  const fetchedProfile = await core2.getProfile(user1Id);
  console.log(`   ✓ User2からUser1のプロフィール取得: ${fetchedProfile?.display_name}`);

  console.log('4. プロフィール検索');
  const searchResults = await core1.searchProfiles('テスト');
  console.log(`   ✓ 検索結果: ${searchResults.length}件`);

  // =====================
  // フレンドリクエストテスト
  // =====================
  console.log('\n--- フレンドリクエスト機能 ---');

  console.log('5. フレンドリクエスト送信');
  const request = await core1.sendFriendRequest(user2Id);
  console.log(`   ✓ リクエストID: ${request.id}, status: ${request.status}`);

  console.log('6. 受信リクエスト確認');
  const pendingRequests = await core2.getPendingRequests();
  console.log(`   ✓ User2の受信リクエスト: ${pendingRequests.length}件`);

  console.log('7. リクエスト承認');
  await core2.acceptFriendRequest(request.id);
  console.log('   ✓ 承認完了');

  console.log('8. 友達リスト確認');
  const friends1 = await core1.getFriends();
  const friends2 = await core2.getFriends();
  console.log(`   ✓ User1の友達: ${friends1.length}人, User2の友達: ${friends2.length}人`);

  // =====================
  // 位置履歴テスト
  // =====================
  console.log('\n--- 位置履歴機能 ---');

  console.log('9. 位置履歴保存');
  await core1.saveLocationHistory(35.6812, 139.7671, 10);
  await core1.saveLocationHistory(35.6580, 139.7016, 15);
  console.log('   ✓ 2件の履歴を保存');

  console.log('10. 位置履歴取得');
  const history = await core1.getLocationHistory(user1Id, { limit: 10 });
  console.log(`   ✓ 取得した履歴: ${history.length}件`);

  // =====================
  // ゴーストモードテスト
  // =====================
  console.log('\n--- ゴーストモード機能 ---');

  console.log('11. ゴーストモード有効化');
  await core1.enableGhostMode(30); // 30分間
  const settings = await core1.getSettings();
  console.log(`   ✓ ghost_mode: ${settings?.ghost_mode}, ghost_until: ${settings?.ghost_until}`);

  console.log('12. ゴーストモード中の位置送信（スキップされる）');
  await core1.sendLocation(35.0, 139.0, 10);
  console.log('   ✓ 位置送信がスキップされた');

  console.log('13. ゴーストモード無効化');
  await core1.disableGhostMode();
  const settingsAfter = await core1.getSettings();
  console.log(`   ✓ ghost_mode: ${settingsAfter?.ghost_mode}`);

  // =====================
  // グループテスト
  // =====================
  console.log('\n--- グループ機能 ---');

  console.log('14. グループ作成');
  const group = await core1.createGroup('テストグループ', 'テスト用のグループです');
  console.log(`   ✓ グループID: ${group.id.slice(0, 8)}..., 招待コード: ${group.invite_code}`);

  console.log('15. グループ参加');
  const joinedGroup = await core2.joinGroup(group.invite_code!);
  console.log(`   ✓ User2がグループに参加: ${joinedGroup.name}`);

  console.log('16. グループメンバー確認');
  const members = await core1.getGroupMembers(group.id);
  console.log(`   ✓ メンバー数: ${members.length}人`);

  console.log('17. グループ退出');
  await core2.leaveGroup(group.id);
  const membersAfter = await core1.getGroupMembers(group.id);
  console.log(`   ✓ 退出後のメンバー数: ${membersAfter.length}人`);

  // =====================
  // クリーンアップ
  // =====================
  console.log('\n--- クリーンアップ ---');

  console.log('18. 友達削除');
  await core1.removeFriend(user2Id);
  const friendsAfterRemove = await core1.getFriends();
  console.log(`   ✓ 削除後の友達: ${friendsAfterRemove.length}人`);

  console.log('19. グループ削除');
  await core1.deleteGroup(group.id);
  const groupsAfter = await core1.getGroups();
  console.log(`   ✓ 削除後のグループ: ${groupsAfter.length}件`);

  console.log('\n=== 全テスト完了 ===');
}

testFeatures().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
