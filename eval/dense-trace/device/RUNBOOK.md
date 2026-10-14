# オンデバイス エネルギー測定 手順書 (RUNBOOK)

「privacy as a sensing scheduler」論文向け。**3つのアーム**の GNSS 取得デューティ比／
消費電力差を、POCO X7 Pro 実機で **有界（各2〜4時間）** に測定する。

| アーム | 動作 | 何を検証するか |
|---|---|---|
| `continuous` | `watchPosition` を最大レートで回し GNSS を常時ウォーム | ベースライン（常時取得） |
| `naive` | continuous と同じ ＋ 各 fix で `createPrivacyProcessor` を実行 | 「取得後にプライバシー計算を足す」素朴案。GNSS は減らず CPU が増える |
| `gated` | 約30秒ごとに `createSensingGate` を評価し、取得可のときだけ 1 回だけ GNSS を取る | 提案手法（取得前ゲート）。GNSS デューティが激減 |

既存の `../results/battery-37h-summary.json`（37.6h 常時稼働ベースライン）と同じ
`dumpsys batterystats` 方式で測る。出力もその形式に合わせている。

**所要時間の目安**: 各アーム3時間推奨（最低2時間）＋準備/回収。合計 **半日〜1日**。
アーム間の充電は OK（ただし測定中は絶対に充電しない）。

---

## 0. 先に「ドライラン」で流れと出力形式を確認（実機不要・5分）

実機なしで、スクリプトの構文と出力 JSON を確認できる。**最初に必ず一度実行**すること。

Windows PowerShell:
```powershell
cd eval\dense-trace\device
foreach ($a in 'continuous','naive','gated') {
  .\adb\measure.ps1 -Action begin -Arm $a -DryRun
  .\adb\measure.ps1 -Action end   -Arm $a -DryRun
}
node .\merge-results.mjs
```

bash（Git Bash / WSL / macOS）:
```bash
cd eval/dense-trace/device
for a in continuous naive gated; do
  ./adb/measure.sh begin $a --dry-run
  ./adb/measure.sh end   $a --dry-run
done
node ./merge-results.mjs
```

`results/device-summary.json` と比較表が出れば OK。**確認後、`results/` 内のドライラン
生成物（`.gitkeep` 以外）を削除**してから本番へ:
```bash
node -e "const fs=require('fs');for(const f of fs.readdirSync('results'))if(f!=='.gitkeep')fs.unlinkSync('results/'+f)"
```

---

## 1. PC 側の一度きりの準備

```bash
node --version                      # v18+ を確認
pnpm install                        # esbuild が入る（新規依存は追加していない）
pnpm --filter @zairn/sdk build      # packages/sdk/dist を生成
cd eval/dense-trace/device
node bundle-sdk.mjs                 # harness/vendor/zairn-privacy.js を生成
```
`harness/vendor/zairn-privacy.js`（約20KB, `window.ZairnPrivacy`）が出来ていれば準備完了。
adb（Android platform-tools）に PATH が通っていること（`adb version`）。

---

## 2. 端末（POCO X7 Pro）の準備

**開発者向け設定**
- 設定 → デバイス情報 → MIUI/HyperOS バージョンを連打 → 開発者オプション有効化
- 開発者オプション → **USB デバッグ ON**
- PC で `adb devices` → 端末が `device` と表示（初回は端末側の許可ダイアログで「常に許可」）

**測定条件（3アームで完全に統一する）**
- 画面: **常時 ON**（ブラウザがバックグラウンドだと GNSS/JS が止まる）
  - 自動輝度 **OFF**・**最低輝度に固定**、自動回転 OFF、スリープ時間を最大に
- 位置情報 **ON**、モードは「高精度」
- **機内モード ON**（Wi-Fi / Bluetooth / モバイル通信 OFF）
  - GNSS は機内モードでも動作する。無線の電力変動を排除でき、位置がネットワーク測位に
    フォールバックせず **GNSS 強制**になる
  - もし数分待っても位置が来ない場合は、機内モードを解除し **Wi-Fi と BT だけ OFF** で再試行
- **バッテリー最適化 / 省電力 OFF**（測定中の CPU/GNSS スロットリング防止）
- 通知オフ・他アプリ終了・「サイレント」で放置
- **物理配置を固定**：同じ窓際、同じ向き、測定中は動かさない（在宅・静止状態を模す）
- 各アーム開始前に十分充電（できれば毎回 90% 以上）。ただし **begin 後は充電しない**。

---

## 3. アームごとの本番手順（continuous → naive → gated の順で3回）

以下 `<ARM>` を `continuous` / `naive` / `gated` に置き換える。

**(1) PC でハーネス配信サーバを起動**
```bash
cd eval/dense-trace/device
node serve.mjs            # http://localhost:8099/ で harness/ を配信
```

**(2) USB 接続し、ポートを端末へトンネル**（USB 接続時に一度）
```bash
adb reverse tcp:8099 tcp:8099
```

**(3) 端末の Chrome でアームのページを開く**
```
http://localhost:8099/index.html?arm=<ARM>&autostart=1
```
- 位置情報の許可ダイアログは「**このサイトの使用中は許可**」
- 上部バナーが `ARM: <ARM>` になり、`GNSS acquisitions` カウンタが増え始めるのを確認
- （localhost 経由なので Chrome は secure context として geolocation を許可する）

**(4) 直前に `begin`（batterystats リセット＋スナップショット）**
```powershell
.\adb\measure.ps1 -Action begin -Arm <ARM>      # PowerShell
```
```bash
./adb/measure.sh begin <ARM>                     # bash
```

**(5) USB を抜く → 電池駆動で放置（2〜4時間、推奨3時間）**
- 画面は **ON のまま**。ページはロード後ネットワーク不要（バンドル・ゲートはすべてローカル）。
- この間の禁止事項：**充電しない・他アプリを触らない・端末を動かさない**。

**(6) 経過後、回収**
- 端末ページで **Stop** を押し、**Export JSON**（または Copy JSON）で `<ARM>.app.json` を保存
  → PC の `eval/dense-trace/device/results/` にコピー（GNSS 取得回数などアプリ側指標。任意だが推奨）
- USB を再接続（ここからは充電 OK）、`end` を実行:
```powershell
.\adb\measure.ps1 -Action end -Arm <ARM>         # PowerShell
```
```bash
./adb/measure.sh end <ARM>                        # bash
```
→ `results/<ARM>.<日時>.run.json`（37h サマリ形式）が自動生成される。

**(7) 次のアームへ**：必要なら充電してから (1) に戻る。3アーム完了まで繰り返す。

> gated は静止時 30分間隔＋60分鮮度フロアのため、2時間だと取得が 2〜3 回と少ない。
> デューティ推定を安定させたいので **3〜4時間**が望ましい。3アームは同じ時間長に揃えること。

---

## 4. 集計

```bash
cd eval/dense-trace/device
node merge-results.mjs
```
→ `results/device-summary.json` と、continuous / naive / gated の比較表
（drain mAh/h、GNSS mAh/h、GNSS デューティ%、continuous 比の削減%）が出力される。

---

## 5. 結果の送付

`eval/dense-trace/device/results/` 内の次を zip でまとめて送る:
- `device-summary.json`（主結果）
- `*.run.json`（各アームのサマリ）
- `*.batterystats.txt`（生ダンプ。再解析用）
- `*.begin.json` / `*.end.json` / `*.app.json`

---

## 補足・トラブルシュート

- **画面電力について**：本手順は画面 ON で走らせるため総 drain には画面分が含まれる。ただし
  画面条件は3アーム共通なので、**アーム間の差分**が GNSS＋プライバシー計算の差を表す。加えて
  `run.json` / `device-summary.json` は batterystats の GNSS 帰属分（`gnss_mAh_per_h`,
  `gnss_duty_pct`）を分離出力しており、これは画面電力に依存しない**主指標**。
- **naive が continuous より少し高い**のが期待挙動（取得後プライバシー計算の CPU 上乗せ）。
  GNSS は減らない＝「取得後にプライバシーを足すだけでは省エネにならない」ことを示す。
- **charge_counter の単位**は端末依存（多くは µAh）。`run.json` の
  `charge_counter_units_guess` を確認。主指標は batterystats の `Computed drain`（mAh）で、
  charge_counter と level 減少は相互チェック用。
- **位置が来ない**：機内モードでも GNSS は動くが初回捕捉に窓際で数分かかる。ダメなら機内モード解除
  ＋Wi-Fi/BT のみ OFF で再試行。
- **`adb devices` に出ない**：USB デバッグ許可ダイアログ、ケーブル/ドライバを確認。
- **中断・クラッシュ**：ハーネスは進捗を localStorage に保存する。ページ再表示で復帰状況を表示。
  それでも不安なら当該アームをやり直す（`-DryRun` なしで begin からやり直し）。
