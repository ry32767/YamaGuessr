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
│   ├── studio.py              # 出題データ追加のローカルUI（127.0.0.1限定）
│   ├── extract_telemetry.py   # DJI動画→テレメトリ
│   ├── match_gpx.py           # テレメトリ×GPX→track.json
│   ├── detect_candidates.py   # 出題候補の自動検出
│   ├── adopt_candidates.py    # 候補の一括採用（レビュー省略の近道）
│   ├── build_library.py       # 動画・写真→画像ライブラリ（位置は推定しない）
│   ├── exif.py                # EXIF読み取り（外部依存なし）
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
3. 遊び方（10問チャレンジ／全地点制覇）、手がかり（地形図当て／3D地形当て）、コース（山）を選ぶ
4. 写真か3D地形を見て、地形図をタップして回答
5. 回答後は正解を中心にした**距離リング**が出て、どのリングに入ったかが分かる
6. リーダーボードで順位を確認

- 地形図には**歩いたGPXルートが重ねて描かれます**。「このルートのどこか」を当てる問題です
- 3D地形当ては**その地点に立った一人称視点**（目線は地面から1.5m）です。地形には地理院の**空中写真**が貼られていて、森や岩の質感で地形が読めます（地名・注記は出ません）。ドラッグで360度見回せ、Googleストリートビューのように**ルートの上を前後に歩けます**（ボタン・矢印キー・ルートのタップ）。上空から見下ろす俯瞰にはなりません
- 歩いても**正解は出発地点**です。離れている間は「出発地点から○m」が出て、3D上には**出題地点のピン**が立ち、「出発地点」ボタンで戻れます
- 動画のフレームが無い地点は、**3D地形当てモード専用**として出題されます。GPXとDEMさえあれば出題できるので、出題数が動画の量に縛られません

## 出題データを作る（開発者向け）

いちばん簡単なのはローカルUIです。

```bash
python pipeline/studio.py
```

ブラウザが開いたら、**GPX・写真・動画をその画面から追加**して、工程を上から順に「実行」します。127.0.0.1にだけ待ち受けるので、このツールが外に公開されることはありません。ローカルで開発サーバを動かしているときは、ゲームのホーム画面にもこのツールへのリンクが出ます（公開先には出ません）。

作り方は2通りあります。

| 素材 | 手順 | 出来るもの |
|---|---|---|
| GPX＋動画／写真 | 候補検出 → 画像ライブラリ → レビューで画像を割り当て → 画像切り出し → 出題データ生成 | 写真やワンシーンを見て当てる地点 |
| GPXだけ | 候補検出 → 候補を全採用 → 出題データ生成 | 3D地形だけで当てる地点 |

**出題地点はGPXの形と地形から決め、画像はレビューで人が割り当てます**（GPXの時刻も写真の撮影時刻も位置の根拠には使いません。理由は[docs/spec.md](docs/spec.md)の設計判断表）。1地点に何枚でも割り当てられます。**iPhoneのHEICは読めない**ので、JPEGに変換してから入れてください。

<details>
<summary>コマンドで1つずつ実行する場合</summary>

```bash
# 1. 出題地点の候補を探す（GPXの形＋地形から。動画は品質判定に使うだけで任意）
python pipeline/detect_candidates.py --gpx Source/route.gpx \
  --out pipeline/data/candidates.json

# 2. 動画と写真から画像ライブラリを作る（位置は推定しない）
python pipeline/build_library.py --video clip=Source/DJI_xxx.MP4 \
  --photos-dir Source/photos --out-dir pipeline/data/library

# 3. レビューで地点に画像を割り当てる（ここが本番。1地点に何枚でも）
python -m http.server   # ルートで起動し /pipeline/review.html を開く

# 4. 割り当てた画像を原本から出題用に書き出す
python pipeline/extract_frames.py final --confirmed pipeline/data/confirmed_points.json \
  --video clip=Source/DJI_xxx.MP4 --out-dir pipeline/data/frames

# 5. 公開用 quiz_points.json とトラックを作る（既存の山はマージされる）
python pipeline/build_quiz_data.py --confirmed pipeline/data/confirmed_points.json \
  --gpx Source/route.gpx --images-dir pipeline/data/frames --public-dir public
```

画像を使わず3D地形だけで出題する場合は 1 → 一括採用 → 5 だけで済みます。

```bash
python pipeline/detect_candidates.py --gpx Source/route.gpx --out pipeline/data/candidates.json
python pipeline/adopt_candidates.py --candidates pipeline/data/candidates.json \
  --mountain-id my-mountain-2026-06-11 --mountain-name "◯◯山" \
  --out pipeline/data/confirmed_points.json
python pipeline/build_quiz_data.py --confirmed pipeline/data/confirmed_points.json \
  --gpx Source/route.gpx --public-dir public
```

</details>

## 開発者・AIエージェント向け
- 作業規約・検証ループ・ドキュメント同期は [AGENTS.md](AGENTS.md)（全エージェント共通）
- Claude Code固有の補足は [CLAUDE.md](CLAUDE.md)
- 仕様・受け入れ条件は [docs/spec.md](docs/spec.md)、他の設計は [docs/README.md](docs/README.md)

## ライセンス
未定
