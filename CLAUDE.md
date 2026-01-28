# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Supabaseを使用したZenlyライクな位置情報共有システムのコア実装。SQL（スキーマ+RLS）とTypeScript SDKで構成。

## ビルド・開発コマンド

```bash
# TypeScript型チェック
tsc --noEmit sdk/javascript/index.ts

# データベース変更の適用（Supabase CLIを使用する場合）
supabase db push
```

SDKはソースとして配布。利用側で `@supabase/supabase-js` をインストールし、`sdk/javascript/index.ts` をインポートして使用。

## アーキテクチャ

### データベース層 (`database/`)
- `schema.sql`: テーブル定義（`locations_current`, `share_rules`, `locations_history`）とインデックス
- `policies.sql`: RLSポリシー。すべてのテーブルでRLSが有効

### SDK (`sdk/javascript/index.ts`)
`createLocationCore()` ファクトリ関数が以下を提供:
- `sendLocation(lat, lon, accuracy?)`: 現在位置のupsert
- `getVisibleFriends()`: RLSでフィルタされた閲覧可能な位置情報を取得
- `allow(viewerId, level)` / `revoke(viewerId)`: 共有ルールの管理
- `subscribeLocations(callback)`: Realtimeによる位置更新の購読

### RLSの仕組み
- ユーザーは自分の位置情報のみ書き込み/更新可能
- 他者の位置閲覧には `share_rules` で許可が必要（`level: 'current'` or `'history'`）
- `expires_at` による期限付き共有をサポート
- `locations_history` の閲覧には `level = 'history'` が必要

## コーディング規約

- TypeScript（SDK）とSQL（データベース）を使用
- インデント: 2スペース
- テーブル/カラム名: snake_case（SQLに合わせる）
- 型（`ShareLevel`, `LocationCurrentRow`）を再利用し、狭く保つ
- Supabaseクライアントをモックした軽量ユニットテストを推奨

## コミット規約

Conventional Commit形式を推奨（`feat:`, `fix:`, `docs:`）。件名は72文字以内。
SQLの変更はRLSへの影響と変更対象のステートメントを明記。SDKの変更は破壊的変更と使用例の更新を記載。
