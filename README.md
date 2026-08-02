# YamaGuessr

> DJIアクションカメラの登山動画から、GeoGuessrの山版を作る。

実際に登った山のドローン/アクションカメラ動画から緯度経度付きテレメトリを抽出し、「ルートが急に曲がった場所」「尾根や谷が見える場所」「ピーク」「コル」など地形的に特徴のある地点だけをクイズ化する。フレーム画像や周辺の3D地形を見て、国土地理院の地形図上で位置を当てるゲーム。

## 主な機能
- **前処理パイプライン** — DJI動画+GPXから出題候補地点を自動抽出し、人間がレビュー・手動追加して確定
- **モード①：地形図当て** — その地点に立った**一人称3D**（写真があれば写真も）を見て、地形図をクリックして位置を推測
- **モード②：3D地形当て** — 周辺の地形モデルを**3人称**で回して眺め、その形だけで位置を推測
- **10問チャレンジモード** — ランダム10問、GeoGuessr式スコアで勝負
- **全地点制覇モード** — 存在する全出題地点を順に解く
- **リーダーボード** — モード別（チャレンジ／制覇 × 地形図／3D）にランキング（Supabase／メールログイン）
- **サウンド演出** — 正解時・完了時の効果音

> 正解データは静的ファイルとして配信される都合上、開発者ツールから閲覧可能です。リーダーボードは名誉制の参考記録として運用します。

> 各機能の受け入れ条件は [docs/spec.md](docs/spec.md)。

## 技術スタック
- **フロントエンド**: Vite + TypeScript（バニラ）+ MapLibre GL JS v5
- **地図・地形**: 国土地理院タイル（地形図／空中写真／DEM標高タイル）。標高タイルは`maplibregl.addProtocol`で自前にterrain-RGBへ変換して3D化（追加ライブラリ無し）
- **前処理**: Python 3.11（動画テレメトリ抽出・GPX照合・候補検出・フレーム切り出し）
- **スコアDB**: Supabase（メールアドレス＋パスワードのログイン＋リーダーボードのみ、クイズデータ自体はDBを使わない）
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
│   ├── supabase.ts        # メールログイン・スコア送信・ランキング
│   ├── map/               # 地理院タイル・3D地形（一人称／3人称）・距離リング
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
2. サイトを開く（**ログインなしで全部遊べます**。スコアを残したいときだけメールアドレスで登録）
3. 遊び方（10問チャレンジ／全地点制覇）、手がかり（地形図当て／3D地形当て）、コース（山）を選ぶ
4. **「見る」タブ**で3D地形（と写真）を読み、**「答える」タブ**で地形図をタップして回答
5. 回答後は正解を中心にした**距離リング**が出て、どのリングに入ったかが分かる
6. リーダーボードで順位を確認

- 出題画面は「見る」と「答える」の**1画面ずつ**です。どちらも読む対象なので、タブで切り替えて画面いっぱいに使います
- 地形図には**歩いたGPXルートが重ねて描かれます**。「このルートのどこか」を当てる問題です
- **地形図当て（モード①）はその地点に立った一人称視点**（目線は地面から1.5m）です。地形には地理院の**空中写真**が貼られていて、森や岩の質感で地形が読めます（地名・注記は出ません）。ドラッグで360度見回せ、**上下のドラッグで見上げ・見下ろし**もできます（水平から始まり±40度まで。上空から見下ろす俯瞰にはなりません）。Googleストリートビューのように**ルートの上を前後に歩けます**（ボタン・矢印キー・ルートのタップ）。写真がある地点では写真も一緒に出ます
- 歩いても**正解は出発地点**です。離れている間は「出発地点から○m」が出て、3D上には**出題地点のピン**が立ち、「出発地点」ボタンで戻れます
- **1問の持ち時間は5分。使うほど点が減ります**（5分でゼロ）。タブの下のタイマーに「残り時間・バー・いま答えたときの倍率（×○%）」が常に出ます
- **3Dで歩いた時間もタイマーに乗ります。** 歩いた道のりを「実際に山を歩いたらかかる時間」（水平4km/h・登り350m/h・下り500m/h）に直して加算するので、100m先まで見に行くと約1分半ぶん減ります。**ただし出題地点より手前に戻るぶんと、一度行った道を戻るぶんは無料**（もう歩いて覚えている道なので）
- **3D地形当て（モード②）は3人称**です。出題地点を中心に地形モデルを外から回して眺め、**その形だけ**で場所を当てます（ルートも写真も出ません）
- 写真が無い地点も**どちらのモードでも出題されます**。GPXとDEMさえあれば出題できるので、出題数が動画の量に縛られません
- 10問チャレンジは、**どの10問かはランダムでも出題順はルートを歩いた順**です

## 出題データを作る（studio の使い方）

出題データ作りは**ローカルUI「studio」だけで完結**します。ターミナルで打つコマンドは、起動の1行だけです。

```bash
python pipeline/studio.py
```

ブラウザが開きます（開かなければ http://127.0.0.1:8770/ ）。**127.0.0.1にだけ待ち受ける**ので、このツールが外から見えることはありません。ゲームをローカルで開いているときは、ホーム画面にもこのツールへのリンクが出ます（公開先には出ません）。

### 何をするツールか

**1本の山行（GPX）を、1つの「コース」にする**ツールです。やっていることは3つだけ：

1. GPXの形と国土地理院の地形データから、**出題に向いた地点**（ピーク・コル・尾根の見晴らし・ルートの屈曲）を自動で拾う
2. 動画・写真を**画像の一覧**にして、「どの画像がどの地点で撮られたか」を**人が**割り当てる
3. `public/data/quiz_points.json` とルート（トラック）に書き出す → ゲームに出る

### 手順（画面の上から順に）

**準備**：「素材を追加」からGPX・動画・写真をドロップ（`Source/` に置かれます）。すでに `Source/` に置いてあるならそのままでOK。次に **山ID**（例 `hyounosen-2026-07-17`）と **山名**（例 `氷ノ山・鉢伏山・瀞川山`）を入れます。山IDはコースの識別子で、**同じIDでもう一度作るとそのコースが作り直され、違うIDなら別コースとして増えます**。

| 持っているもの | 押す順番 | できる出題 |
|---|---|---|
| **GPXだけ** | ① 出題地点を探す → ④ 候補を全採用 → ⑥ 出題データ生成 | 3D地形だけを見て当てる（いちばん手軽） |
| **GPX＋動画/写真** | ① → ② 画像ライブラリ → ③ レビュー → ⑤ 出題用画像 → ⑥ | 上に加えて、その地点で撮った画像を見て当てる |

- 各工程のボタンは、**前提が足りないと押せず、理由が出ます**（「先に候補を探してください」など）。実行中の出力は右のログに流れ、最後が「完了」なら成功です。
- **③レビューが本番**です。別タブで開き、地図のピンで地点を選び → 右の一覧から**その地点で撮った画像**をクリックして割り当てます（1地点に何枚でも）。いらない候補は `R` で却下、地図の空白を Shift+クリックで地点を手動追加。終わったら**「studioに保存」**を押すだけで確定データが書き戻ります（ダウンロードは不要）。
- 画像を割り当てなかった地点は**3D地形だけの出題**になります。動画が無くても出題数は減りません。
- ⑦⑧は参考用（動画のGPS・姿勢を覗くだけ）。**通常は使いません。**

### つまずきやすいところ

- **タイムラプス動画は「切り出し間隔」を詰める。** 数時間の山行が20秒程度に圧縮されているので、既定の2秒では10枚ほどしか出ません。**0.2〜0.5秒**にすると数十枚になります
- **iPhoneのHEICは読めません。** JPEGに変換してから入れてください
- **LINEやSNS経由の写真はEXIF（撮影日時・GPS）が消えています。** 並び順の手がかりが無くなるだけで割り当て自体はできますが、元データを直接入れるほうが扱いやすいです
- **山ID・山名を入れないと④⑥は押せません**（コースの名前が決まらないため）
- 作り直したいときは、**同じ山IDで①からやり直せば上書き**されます。別の山を足すときは山IDを変えるだけで、既存のコースは消えません

**出題地点はGPXの形と地形から決め、画像はレビューで人が割り当てます**（GPXの時刻も写真の撮影時刻も位置の根拠には使いません。理由は[docs/spec.md](docs/spec.md)の設計判断表）。

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
#    studio（python pipeline/studio.py）の「レビュー」から開き、「studioに保存」で
#    pipeline/data/confirmed_points.json に直接書く。
#    studioを使わない場合は python -m http.server で /pipeline/review.html を開き、
#    「ファイルに書き出す」で落として同じ場所に置く

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
