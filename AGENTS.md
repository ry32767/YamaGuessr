# AGENTS.md

> このプロジェクトでコードを書く**すべてのAIエージェント（Codex / Cursor / Claude Codeなど）共通の作業規約**。作業前に読むこと。Claude Codeは`CLAUDE.md`経由で読み込む。

## ドキュメントの役割
- **README.md**（直下・人間向け）：概要・フォルダ構成・使い方。AI専用手順は書かない。
- **AGENTS.md**（このファイル）：作業規約・コマンド・検証ループ・ドキュメント同期規約。
- **CLAUDE.md**（直下）：Claude Code固有の補足のみ（このファイルを読み込む薄いラッパ）。
- **docs/**：`spec.md`（仕様・受け入れ条件＝合格ライン）、`README.md`（索引）、`data-model.md`（quiz_points.jsonとSupabaseスキーマ）、`pipeline.md`（動画→出題データの前処理手順）、`operations.md`（デプロイ・環境変数）。

作業前に：概要はREADME.md、実装する機能と受け入れ条件は`docs/spec.md`、データ構造は`docs/data-model.md`、前処理は`docs/pipeline.md`を読む。

## Tech Stack
| レイヤー | 技術 |
|---|---|
| フロントエンド | Vite + TypeScript（バニラ、フレームワーク無し）+ MapLibre GL JS **v5** |
| 3D地形 | MapLibre GL Terrain（国土地理院DEM。標高タイルは`addProtocol`で自前変換、外部ライブラリ無し）。一人称は`centerClampedToGround: false`＋`pitch>90`（v5必須） |
| 前処理 | Python 3.11（`pipeline/`、ffmpeg依存） |
| DB | Supabase（Postgres／匿名認証＋スコアのみ。クイズデータはDB不使用） |
| Deploy | GitHub Pages + GitHub Actions |

## Commands

フロントエンド：
```bash
npm install      # 依存
npm run dev       # 開発サーバ起動
npm test          # vitest（scoring.ts等のユニットテスト）
npm run lint       # eslint + tsc --noEmit
npm run build      # 本番ビルド
```

前処理パイプライン（Python、ローカル実行のみ・CIには含まない）：
```bash
pip install -r pipeline/requirements.txt
pytest pipeline/                                   # 前処理ロジックのユニットテスト
python pipeline/studio.py                          # ← 出題データ追加のローカルUI（127.0.0.1限定）
python pipeline/extract_telemetry.py Source/DJI_xxx.MP4 \
  -o pipeline/data/telemetry.csv \
  --json pipeline/data/telemetry.json \
  --summary pipeline/data/telemetry_summary.json   # ← タイムラプス倍率・GPS健全性はここを見る
python pipeline/match_gpx.py --gpx Source/route.gpx \
  --telemetry pipeline/data/telemetry.json \
  --out pipeline/data/track.json                   # 分割動画は --telemetry を複数回
python pipeline/detect_candidates.py --track pipeline/data/track.json \
  --video clip=Source/DJI_xxx.MP4 \
  --out pipeline/data/candidates.json                # --gpx だけでも実行可（3D専用地点）
python pipeline/build_library.py \
  --video clip=Source/DJI_xxx.MP4 --photos-dir Source/photos \
  --out-dir pipeline/data/library                    # 動画・写真→画像ライブラリ（位置は推定しない）
python pipeline/extract_frames.py previews \
  --candidates pipeline/data/candidates.json \
  --video clip=Source/DJI_xxx.MP4 --out-dir pipeline/data/previews
                                                   # ← レビューは studio の「レビュー」から開き、
                                                   #    「studioに保存」で confirmed_points.json を書く
                                                   #    （studio 抜きなら python -m http.server で
                                                   #     /pipeline/review.html を開き、書き出して置く）
python pipeline/extract_frames.py final \
  --confirmed pipeline/data/confirmed_points.json \
  --video clip=Source/DJI_xxx.MP4 --out-dir pipeline/data/frames
python pipeline/build_quiz_data.py \
  --confirmed pipeline/data/confirmed_points.json \
  --gpx Source/route.gpx --images-dir pipeline/data/frames --public-dir public
```

テスト用fixture（`pipeline/tests/fixtures/sample_djmd.mp4`）は実動画からテレメトリトラックだけを抜いた25KBのMP4。実動画を差し替えたら次で作り直す：

```bash
python pipeline/tests/make_fixture.py Source/DJI_xxx.MP4 -n 120
```

## Verification Loop（検証ループ）
**機能を実装したら、完了宣言の前に必ず回す。** 最重要の規約。

1. 実装する
2. 検証する：フロントエンドは`npm test` / `npm run lint` / `npm run build`、前処理スクリプトは`pytest pipeline/`＋実データでの実行結果を目視確認
3. `docs/spec.md`の該当機能の**受け入れ条件**を1つずつ照合
4. 1つでも失敗・未達なら原因を直して2に戻る
5. すべてgreenかつ全受け入れ条件○で初めて「完了」

ルール：テスト/Lint/型/ビルドにエラーがある状態で「完了」と言わない。仕様の不備で満たせないときは`docs/spec.md`の「未決定事項」に追記して相談。手動確認（3D地形の見た目、スマホ実機操作感など自動化しづらいもの）は何をどう確認したか一言報告。テストの無い受け入れ条件は可能なら先にテストを書く。

## ドキュメント同期規約
コードだけ進んでdocsが古くなると土台が嘘になる。だから：
- **仕様や挙動を変えたら、対応するドキュメントを同じ変更（コミット）で更新する**：機能・受け入れ条件・タスク→`docs/spec.md`、quiz_points.json/Supabaseスキーマ→`docs/data-model.md`、前処理手順→`docs/pipeline.md`、デプロイ・環境変数→`docs/operations.md`、使い方・セットアップ→`README.md`。
- **docsを増減したら`docs/README.md`の索引も直す。** 図を持つdocsは実装とズレたら図も直す。
- 今すぐ直せないズレは`docs/spec.md`の「未決定事項」に残して放置しない。

## デザイン
UIを触るときは **[DESIGN.md](DESIGN.md) を先に読む**。色・書体・余白・角丸はすべて`src/styles/tokens.css`のトークンから引き、コンポーネント側にベタ書きしない。DESIGN.mdには「避けると決めた初期値」と、壊してはいけない不変条件（地理院タイルの出典表示、3Dに注記入りタイルを貼らない、タップ領域44px、色だけで状態を表さない等）が書いてある。

## コーディング規約
- TypeScriptは`any`禁止、フロントエンドにフレームワークは追加しない（バニラTSを維持）
- Pythonは型ヒント必須、pipelineスクリプトは1機能1ファイル
- コメント・UI文言は日本語

## Do NOT
- 依存を勝手に追加しない（特にフロントエンドへの重量フレームワーク導入）
- `.env`・Supabaseのservice_role keyをコミットしない（anon keyのみ`.env.example`で例示）
- README.mdにAI向け手順を書かない（人間向けに保つ）
- 仕様を変えたのにdocsを直さず「完了」と言わない
- pipeline/data/（中間生成物）やSource動画をリポジトリにコミットしない（.gitignore対象、確定物のみpublic/へ）
- **モード②の3D地形に地名・注記の入ったタイル（標準地図・淡色地図）をテクスチャとして貼らない**（答えが画面に表示される）。テクスチャは注記の無い空中写真（`seamlessphoto`）を使う
- **正解座標を画像ファイル名・EXIFに含めない**（`-map_metadata -1`を必ず付ける）
- **地理院タイルの出典表示を消さない**（利用規約上の必須事項）
- **生GPS座標をPointの正解として使わない**（必ずGPXにスナップした座標を使う。理由はdocs/spec.mdの設計判断表）
