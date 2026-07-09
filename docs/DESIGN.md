# Design Guide — Color Tokens

ロゴ（`assets/logo.svg`）から抽出したブランド色をベースにしたカラートークン定義。
全コントラスト値は WCAG 2.1 相対輝度で実測。

## 1. ブランドシード（ロゴ抽出）

ロゴは「積層スウッシュ + ワードマーク」構成。波4層が暖→冷のスペクトルを描く。

| トークン | HEX | RGB | 出所 | 前景色 |
|---|---|---|---|---|
| **Aqua**（プライマリ） | `#00E5CC` | 0,229,204 | 上波（ベクター） | **Ink** のみ |
| **Amber**（セカンダリ） | `#FFAB00` | 255,171,0 | 最上波（ベクター） | **Ink** のみ |
| **Teal**（ディープ） | `#00B3A4` | 0,179,164 | 第2波（ラスター実測） | White |
| **Coral**（アクセント） | `#FF5A43` | 255,90,67 | 底波（ラスター実測） | Ink / White(大) |
| **Ink**（テキスト/ワードマーク） | `#0F0E0D` | 15,14,13 | 文字 | White |

> Aqua と Teal は hue がほぼ同系（169° / 175°）。**Teal は Aqua ランプの 650 相当**として扱い、
> 独立色ではなく深色域に統合する。

## 2. シグネチャーグラデーション

```css
/* 2-stop ブランドグラデ（基本） */
--grad-brand:    linear-gradient(135deg, #FFAB00 0%, #00E5CC 100%);
/* 4-stop フルスペクトル（ロゴ波の再現・ヒーロー用） */
--grad-spectrum: linear-gradient(135deg, #FF5A43 0%, #FFAB00 35%, #00E5CC 75%, #00B3A4 100%);
```

## 3. トーナルランプ（50–900）

**Aqua**（primary hue）
| 50 | 100 | 200 | 300 | 400 | **500** | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|
|`#EBFEFC`|`#CEFDF8`|`#99FFF4`|`#5CFFED`|`#29FFE8`|**`#00E5CC`**|`#00C3AD`|`#00A08F`|`#007E70`|`#006056`|

**Amber**（secondary hue）
| 50 | 100 | 200 | 300 | 400 | **500** | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|
|`#FEF8EB`|`#FDEDCE`|`#FFDD99`|`#FFC95C`|`#FFB829`|**`#FFAB00`**|`#D99100`|`#B37800`|`#8C5E00`|`#6B4800`|

**Coral**（tertiary hue）
| 50 | 100 | 200 | 300 | 400 | **500** | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|
|`#FEEEEB`|`#FDD4CE`|`#FFA599`|`#FF705C`|`#FF6550`|**`#FF5A43`**|`#FF3013`|`#E11C00`|`#B11600`|`#871100`|

**Neutral / Ink**（warm gray, hue 30°）
| 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | **950** |
|---|---|---|---|---|---|---|---|---|---|---|
|`#F9F9F8`|`#F3F2F1`|`#E7E6E4`|`#D6D4D1`|`#AEA8A3`|`#878078`|`#6C6660`|`#514D48`|`#312E2B`|`#181716`|**`#0F0E0D`**|

## 4. アクセシビリティ（WCAG 実測）

| ペア | コントラスト | 判定 |
|---|---|---|
| Aqua-500 `#00E5CC` + **Ink** | 12.0:1 | AAA |
| Aqua-500 `#00E5CC` + White | 1.6:1 | 使用禁止 |
| Aqua-800 `#007E70` + White | 5.0:1 | AA（白文字の塗りボタン用） |
| Amber-500 `#FFAB00` + **Ink** | 10.2:1 | AAA |
| Amber-500 `#FFAB00` + White | 1.9:1 | 使用禁止 |
| Coral-500 `#FF5A43` + Ink | 6.2:1 | AA |
| Coral-700 `#E11C00` + White | 4.8:1 | AA |
| 全 50/100 コンテナ + Ink | 14–18:1 | AAA |

**鉄則:** 明色ブランド（Aqua / Amber-500）は**必ず Ink 前景**。
白文字が要る塗りは深色トーン（Aqua-800 / Amber-800 / Coral-700）を使う。

## 5. セマンティックトークン（Material 3 ロール / 既存 `--md-*` にドロップイン可）

```css
:root {
  /* ---- Brand raw ramps ---- */
  --brand-aqua: #00E5CC;  --brand-amber: #FFAB00;
  --brand-teal: #00B3A4;  --brand-coral: #FF5A43;  --brand-ink: #0F0E0D;
  --grad-brand:    linear-gradient(135deg, #FFAB00 0%, #00E5CC 100%);
  --grad-spectrum: linear-gradient(135deg, #FF5A43 0%, #FFAB00 35%, #00E5CC 75%, #00B3A4 100%);

  /* ---- Primary = Aqua ---- */
  --md-primary: #007E70;            /* 塗り+白文字用 (AA) */
  --md-primary-bright: #00E5CC;     /* シグネチャ・アクセント(FAB/ハイライト, Ink前景) */
  --md-on-primary: #FFFFFF;
  --md-primary-container: #CEFDF8;
  --md-on-primary-container: #00352F;

  /* ---- Secondary = Amber ---- */
  --md-secondary: #FFAB00;          /* Ink前景 */
  --md-on-secondary: #0F0E0D;
  --md-secondary-container: #FDEDCE;
  --md-on-secondary-container: #4A3200;

  /* ---- Tertiary = Coral ---- */
  --md-tertiary: #FF5A43;
  --md-on-tertiary: #0F0E0D;
  --md-tertiary-container: #FDD4CE;
  --md-on-tertiary-container: #5C0B00;

  /* ---- Error (ブランドCoralと衝突回避のため真紅を維持) ---- */
  --md-error: #BA1A1A;  --md-on-error: #FFFFFF;
  --md-error-container: #FFDAD6;  --md-on-error-container: #410002;

  /* ---- Neutral / Surface ---- */
  --md-surface: #F9F9F8;            --md-on-surface: #0F0E0D;
  --md-surface-variant: #E7E6E4;    --md-on-surface-variant: #514D48;
  --md-surface-container-low: #F3F2F1;
  --md-surface-container: #EDEBE9;
  --md-surface-container-high: #E7E6E4;
  --md-outline: #AEA8A3;            --md-outline-variant: #D6D4D1;
  --md-inverse-surface: #312E2B;    --md-inverse-on-surface: #F3F2F1;
  --md-inverse-primary: #5CFFED;
  --md-shadow: rgba(15,14,13,.15);  --md-scrim: rgba(15,14,13,.4);
}

@media (prefers-color-scheme: dark) {
  :root {
    --md-primary: #29FFE8;          /* Ink前景 */
    --md-on-primary: #0F0E0D;
    --md-primary-container: #006056;
    --md-on-primary-container: #CEFDF8;

    --md-secondary: #FFC95C;        /* Ink前景 */
    --md-on-secondary: #0F0E0D;
    --md-secondary-container: #6B4800;
    --md-on-secondary-container: #FFDD99;

    --md-tertiary: #FF8A6F;
    --md-on-tertiary: #0F0E0D;
    --md-tertiary-container: #871100;
    --md-on-tertiary-container: #FFD4CB;

    --md-error: #FFB4AB;  --md-on-error: #690005;
    --md-error-container: #93000A;  --md-on-error-container: #FFDAD6;

    --md-surface: #181716;          --md-on-surface: #F3F2F1;
    --md-surface-variant: #514D48;  --md-on-surface-variant: #D6D4D1;
    --md-surface-container-low: #0F0E0D;
    --md-surface-container: #211F1D;
    --md-surface-container-high: #312E2B;
    --md-outline: #6C6660;          --md-outline-variant: #514D48;
    --md-inverse-surface: #F3F2F1;  --md-inverse-on-surface: #312E2B;
    --md-inverse-primary: #007E70;
    --md-shadow: rgba(0,0,0,.4);    --md-scrim: rgba(0,0,0,.6);
  }
}
```

## 6. 適用メモ

現状の `apps/web/src/styles/globals.css` はパープル（`--md-primary: #6442d6`）で**ロゴと不一致**。
§5 のトークンに差し替えると配色が大きく変わる。差し替え対象は以下の `globals.css`:

- `apps/web/src/styles/globals.css`
- `apps/geo-drop-demo/src/styles/globals.css`
- `examples/{zkp-demo,treasure-hunt,social-map}/src/styles/globals.css`
