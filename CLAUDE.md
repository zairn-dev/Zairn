# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Supabaseを使用したZenlyライクな位置情報共有システム。SQL（スキーマ+RLS）とTypeScript SDKで構成され、Next.jsベースのWebフロントエンドも含む。

## ビルド・開発コマンド

```bash
# SDKの型チェック
tsc --noEmit sdk/javascript/index.ts

# テスト実行（ルートディレクトリで）
npm run test:connection    # Supabase接続テスト
npm run test:auth          # 認証テスト
npm run test:sdk           # SDK基本機能テスト
npm run test:realtime      # Realtime購読テスト
npm run test:features      # プロフィール・フレンド・グループ等のテスト
npm run test:chat          # チャット・Bump機能テスト

# Webフロントエンド（web/ディレクトリで）
npm run dev                # 開発サーバー起動
npm run build              # 本番ビルド
npm run lint               # ESLint実行

# データベース変更の適用
supabase db push
```

テストは `.env` ファイルで `SUPABASE_URL` と `SUPABASE_ANON_KEY` を設定して実行。

## アーキテクチャ

### データベース層 (`database/`)
- `schema.sql`: 全テーブル定義とインデックス
- `policies.sql`: RLSポリシー（全テーブルでRLSが有効）

**主要テーブル:**
| テーブル | 用途 |
|----------|------|
| `locations_current` | 現在位置（ユーザーごとに1行、upsert） |
| `locations_history` | 位置履歴 |
| `share_rules` | 共有ルール（level: none/current/history） |
| `profiles` | ユーザープロフィール |
| `friend_requests` | フレンドリクエスト（status: pending/accepted/rejected） |
| `user_settings` | ゴーストモード等の設定 |
| `groups` / `group_members` | グループとメンバー |
| `chat_rooms` / `chat_room_members` / `messages` | チャット機能 |
| `location_reactions` | 絵文字ポーク機能 |
| `bump_events` | 近くの人検出ログ |

### SDK (`sdk/javascript/index.ts`)
`createLocationCore()` ファクトリ関数が全機能を提供。Supabase Authで認証必須。

**機能グループ:**
- **位置情報**: `sendLocation`, `getVisibleFriends`, `getLocationHistory`, `saveLocationHistory`
- **フレンド**: `sendFriendRequest`, `acceptFriendRequest`, `getFriends`, `removeFriend`
- **プロフィール**: `getProfile`, `updateProfile`, `searchProfiles`
- **グループ**: `createGroup`, `joinGroup`, `getGroups`, `leaveGroup`
- **チャット**: `getOrCreateDirectChat`, `sendMessage`, `getMessages`, `subscribeMessages`
- **リアクション**: `sendReaction`, `getReceivedReactions`, `subscribeReactions`
- **Bump**: `findNearbyFriends`, `recordBump`, `getBumpHistory`
- **設定**: `enableGhostMode`, `disableGhostMode`, `updateSettings`
- **Realtime**: `subscribeLocations`, `subscribeFriendRequests`

### Webフロントエンド (`web/`)
Next.js 16 + React 19 + Tailwind CSS。地図表示にLeaflet/react-leafletを使用。Supabase SSRで認証管理。

### RLSの仕組み
- ユーザーは自分のデータのみ書き込み/更新可能
- 他者の位置閲覧には `share_rules` で許可が必要（`level: 'current'` or `'history'`）
- `expires_at` による期限付き共有をサポート
- フレンドリクエスト承認時に双方向で共有ルールが自動作成される
- チャットはルームメンバーまたはグループメンバーのみアクセス可能

## コーディング規約

- インデント: 2スペース
- テーブル/カラム名: snake_case（SQLに合わせる）
- 型（`ShareLevel`, `LocationCurrentRow`等）を再利用し、狭く保つ

## コミット規約

Conventional Commit形式（`feat:`, `fix:`, `docs:`）。件名は72文字以内。
SQLの変更はRLSへの影響を明記。SDKの変更は破壊的変更を記載。
