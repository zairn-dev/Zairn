# UI監査 早見表（コーディング中に開いておく用）

`PROTOCOL.md` の要点だけ。1 presence cue = 1行。埋めるのは `construct` /
`display_form` / `exact_ui_wording` / `notes` の4列。

---

## display_form ← 本監査の中心変数。まずこれを決める

> **唯一の判断ルール:** そのラベルは、ユーザーに *「これは推定だ／古いかもしれない」* と
> 伝えているか？ → **伝えていなければ `asserted-as-fact`。**

| 値 | いつ | 例 |
|---|---|---|
| `asserted-as-fact` | 不確実性・鮮度の注記なしで断定 | 「自宅」「渋谷駅」「〇〇に到着しました」「1.2 km」 |
| `hedged-uncertain` | 不確実性・鮮度を明示している | 「約2 km」「最終更新 5分前」「位置が見つかりません」「おおよそ」 |
| `raw-data` | 解釈なしの生データだけ | 地図ピンのみ・座標・素のタイムスタンプ・速度の数値 |

**迷ったら:** 場所名・到着/出発の断定 = ほぼ `asserted-as-fact`。
「〜分前」「約」等の但し書きが**見えている**なら `hedged-uncertain`。
ピン/数値だけで言葉の解釈がなければ `raw-data`。

---

## construct ← そのcueが表す「存在」の種類（K1〜K5）

| コード | 種類 | トリガー | UI例 |
|---|---|---|---|
| **K1** | place 場所 | 「〇〇にいる」場所名・住所 | 「自宅」「渋谷駅」ラベル |
| **K2** | nearby 近接 | 距離・近さ | 「1.2 km先」「近くにいます」 |
| **K3** | co-presence 同席 | 複数人が同じ場所に「一緒」 | メンバーをまとめ表示 |
| **K4** | reachable 到達可能 | 連絡可・オンライン・応答性 | 「オンライン」「アクティブ」 |
| **K5** | absence 不在/鮮度 | いない・オフライン・最後に見た | 「オフライン」「最終更新 5分前」 |

1つのcueが複数構成概念に跨るときは主たるK1つを入れ、`notes` に補足（または行を分ける）。

---

## 迷いやすい組み合わせ（先回り）

- 「自宅」ラベル（時刻注記なし） → **K1 + asserted-as-fact**
- 「最終更新 5分前」 → **K5 + hedged-uncertain**（鮮度を明示している）
- 素の地図ピンだけ → **raw-data**（K1 か K2 は文脈で）
- 「〇〇に到着しました」通知 → **K1 + asserted-as-fact**
- 「約2 km先」 → **K2 + hedged-uncertain**（「約」がある）
- 「1.2 km先」（言い切り） → **K2 + asserted-as-fact**

---

## 撮影・保存

- 保存先: `docs/ui-audit/screenshots/`
- 命名: `app_screen_nn.png`（例 `life360_mainmap_01.png`）
  - app: `life360` / `findmy` / `snapmap` / `gmaps` / `zenly`
  - screen: `mainmap` / `frienddetail` / `place_arrival` / `status` / `copresence`
- 1画面に複数cueがあれば **行を追加**し `nn` を連番（`_02`, `_03`…）
- 画面が無い/確認不可なら、その行は `notes` に理由だけ書いて他列は空欄

## 記入後

```
node docs/ui-audit/summarize-audit.mjs
```
→ asserted-as-fact率（全体・構成概念別・アプリ別）が出る。
