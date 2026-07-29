# YamaGuessr

> DJIアクションカメラの登山動画から、GeoGuessrの山版を作る。

実際に登った山のドローン/アクションカメラ動画から緯度経度付きテレメトリを抽出し、「ルートが急に曲がった場所」「尾根や谷が見える場所」「ピーク」「コル」など地形的に特徴のある地点だけをクイズ化する。フレーム画像や周辺の3D地形を見て、国土地理院の地形図上で位置を当てるゲーム。

## 主な機能
- **前処理パイプライン** — DJI動画+GPXから出題候補地点を自動抽出し、人間がレビュー・手動追加して確定
- **モード①：地形図当て** — 動画フレーム画像を見て地形図をクリックして位置を推測
- **モード②：3D地形当て** — フレーム画像＋周辺3D地形（見回し可能）で位置を推測
- **10問チャレンジモード** — ランダム10問、GeoGuessr式スコアで勝負
- **全地点制覇モード** — 存在する全出題地点を順に解く
- **リーダーボード** — モード別（チャレンジ／制覇 × 地形図／3D）にランキング（Supabase）
- **サウンド演出** — 正解時・完了時の効果音

> 正解データは静的ファイルとして配信される都合上、開発者ツールから閲覧可能です。リーダーボードは名誉制の参考記録として運用します。

> 各機能の受け入れ条件は [docs/spec.md](docs/spec.md)。

## 技術スタック
- **フロントエンド**: Vite + TypeScript（バニラ）+ MapLibre GL JS
- **地図・地形**: 国土地理院タイル（地形図／DEM標高タイル、`maplibre-gl-gsi-terrain`で3D地形化）
- **前処理**: Python 3.11（動画テレメトリ抽出・GPX照合・候補検出・フレーム切り出し）
- **スコアDB**: Supabase（匿名認証＋リーダーボードのみ、クイズデータ自体はDBを使わない）
- **デプロイ**: GitHub Pages + GitHub Actions

## フォルダ構成

```
YamaGuessr/
├── README.md              # このファイル
├── AGENTS.md              # AIエージェント共通の作業規約・検証ループ
├── CLAUDE.md              # Claude Code固有の補足（AGENTS.mdを読み込む）
├── index.html             # フロントエンドのエントリHTML
├── package.json           # npmスクリプト・依存
├── tsconfig.json          # TypeScript設定
├── vite.config.ts         # Vite + Vitest設定
├── eslint.config.js       # ESLint設定
├── .env.example           # Supabaseの環境変数ひな形（実値は.envへ）
├── .github/workflows/     # GitHub Pagesへのデプロイ
├── docs/                  # 仕様・設計ドキュメント
├── pipeline/              # 動画→出題データの前処理（Python、ローカル実行）
│   ├── extract_telemetry.py   # DJI動画→テレメトリ
│   ├── match_gpx.py           # テレメトリ×GPX→track.json
│   ├── detect_candidates.py   # 出題候補の自動検出
│   ├── dem.py                 # 国土地理院の標高タイル
│   ├── frame_quality.py       # フレームのブレ・明るさ判定
│   ├── geo.py / gpx.py        # 幾何計算・GPX読み込み
│   ├── requirements.txt
│   ├── data/              # 中間生成物・DEMキャッシュ（gitignore）
│   └── tests/             # pytest（fixtures/に小さなテスト用MP4）
├── public/                # 静的アセット（data/quiz_points.json・images/・sounds/）
├── src/                   # フロントエンドソース（TypeScript、フレームワーク無し）
│   ├── app.ts             # 画面の組み立てと遷移
│   ├── session.ts         # 出題セッション（10問チャレンジ／全地点制覇）
│   ├── scoring.ts         # スコア計算
│   ├── sound.ts           # 効果音（Web Audioで合成、音源ファイル無し）
│   ├── supabase.ts        # 匿名認証・スコア送信・ランキング
│   ├── map/               # 地理院タイル・3D地形・距離リング
│   ├── screens/           # 出題画面
│   └── styles/            # デザイントークンとCSS
├── supabase/schema.sql    # スコアDBのスキーマ・RLS
├── DESIGN.md              # デザインの正（トークンの根拠・不変条件）
└── Source/                # 元動画・GPX原本の置き場（gitignore、コミットしない）
```

## セットアップ

```bash
npm install
cp .env.example .env   # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定
npm run dev
```

前処理パイプラインの実行には別途 Python 3.11以上 と ffmpeg が必要（詳細は [docs/pipeline.md](docs/pipeline.md)）。

```bash
pip install -r pipeline/requirements.txt
```

## 使い方

1. `pipeline/` で動画とGPXから出題地点を作成（開発者のみ、詳細は [docs/pipeline.md](docs/pipeline.md)）
2. サイトを開き、ニックネームを設定
3. 遊び方（10問チャレンジ／全地点制覇）と手がかり（地形図当て／3D地形当て）を選ぶ
4. 写真か3D地形を見て、地形図をタップして回答
5. 回答後は正解を中心にした**距離リング**が出て、どのリングに入ったかが分かる
6. リーダーボードで順位を確認

> 動画のフレームが無い地点は、**3D地形当てモード専用**として出題されます。GPXとDEMさえあれば出題できるので、出題数が動画の量に縛られません。

## 出題データを作る（開発者向け）

```bash
# 1. 動画からテレメトリを抽出（タイムラプス倍率・GPSの健全性もここで分かる）
python pipeline/extract_telemetry.py Source/DJI_xxx.MP4 \
  -o pipeline/data/telemetry.csv --json pipeline/data/telemetry.json \
  --summary pipeline/data/telemetry_summary.json

# 2. GPXに突き合わせる（分割動画は --telemetry を複数回）
python pipeline/match_gpx.py --gpx Source/route.gpx \
  --telemetry pipeline/data/telemetry.json --out pipeline/data/track.json

# 3. 候補地点を検出（--gpx だけでも実行でき、その場合は3D専用地点になる）
python pipeline/detect_candidates.py --track pipeline/data/track.json \
  --video clip=Source/DJI_xxx.MP4 --out pipeline/data/candidates.json

# 4. レビュー用プレビューを生成し、review.html で採否と時刻を決める
python pipeline/extract_frames.py previews --candidates pipeline/data/candidates.json \
  --video clip=Source/DJI_xxx.MP4 --out-dir pipeline/data/previews
python -m http.server   # ルートで起動し /pipeline/review.html を開く

# 5. 確定した時刻から本番画像を切り出す
python pipeline/extract_frames.py final --confirmed pipeline/data/confirmed_points.json \
  --video clip=Source/DJI_xxx.MP4 --out-dir pipeline/data/frames

# 6. 公開用 quiz_points.json を作る（既存の山はマージされる）
python pipeline/build_quiz_data.py --confirmed pipeline/data/confirmed_points.json \
  --gpx Source/route.gpx --images-dir pipeline/data/frames --public-dir public
```

## 開発者・AIエージェント向け
- 作業規約・検証ループ・ドキュメント同期は [AGENTS.md](AGENTS.md)（全エージェント共通）
- Claude Code固有の補足は [CLAUDE.md](CLAUDE.md)
- 仕様・受け入れ条件は [docs/spec.md](docs/spec.md)、他の設計は [docs/README.md](docs/README.md)

## ライセンス
未定
