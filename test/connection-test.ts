import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

async function testConnection() {
  console.log('=== Supabase接続テスト ===\n');

  // 1. クライアント作成
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  console.log('✓ Supabaseクライアント作成完了');

  // 2. テーブル存在確認
  const tables = ['locations_current', 'share_rules', 'locations_history'];

  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (error) {
      console.log(`✗ テーブル "${table}" エラー: ${error.message}`);
    } else {
      console.log(`✓ テーブル "${table}" 確認OK`);
    }
  }

  console.log('\n=== テスト完了 ===');
}

testConnection().catch(console.error);
