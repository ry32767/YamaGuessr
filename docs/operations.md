# デプロイ・運用

| 変数 | 用途 | 例 |
|---|---|---|
| `VITE_SUPABASE_URL` | SupabaseプロジェクトURL | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key（公開前提、RLSで保護） | `eyJ...` |

> 実値はコミットしない（`.env.example`に雛形）。anon keyはブラウザに露出する前提の鍵であり、書き込み制御は`supabase/schema.sql`のRLSポリシーで行う（service_role keyは絶対にフロントに置かない）。

## デプロイ手順（GitHub Pages + GitHub Actions）
`main`へpushすると[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)が走る。

1. `npm ci` → `npm run lint` → `npm test` → `npm run build`（**どれか1つでも落ちれば公開されない**）
2. `dist/`を Pages のアーティファクトとしてアップロードし、`actions/deploy-pages`で公開する
   （`gh-pages`ブランチは使わない。リポジトリの Settings → Pages で **Source = GitHub Actions** にしておく）
3. 公開先は `https://<ユーザー名>.github.io/YamaGuessr/`。このパスに合わせて`vite.config.ts`が`base: '/YamaGuessr/'`を付ける
   （**リポジトリ名を変えたら`base`も変える**。変えないとJS・CSS・データが404になる）

## 公開前チェックリスト
- [ ] `npm run lint` / `npm test` / `npm run build` がローカルでgreen（CIと同じ）
- [ ] `public/data/quiz_points.json` と `public/data/tracks/*.json`、使うなら`public/images/`をコミットしてある（**中間生成物`pipeline/data/`とSource動画は入れない**）
- [ ] **`.env`をコミットしていない**（`.env.example`は値を入れないひな形のまま）
- [ ] GitHub の Settings → Secrets and variables → Actions に `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を登録（**未登録でもゲームは動く**。リーダーボードだけ無効になる）
- [ ] Supabase側の初期セットアップ（下記）が済んでいる

## Supabase初期セットアップ
1. Supabaseプロジェクトを作成する
2. **Authentication → Sign In / Providers → Anonymous sign-ins を有効化**（無効のままだとサインインに失敗し、リーダーボードが使えない）
3. **SQL Editor で`supabase/schema.sql`を実行**して`players`/`scores`テーブルとRLSポリシーを作る
4. プロジェクトURL・anon keyを`.env`（ローカル）とGitHub Actions Secrets（ビルド時に埋め込み）双方に設定する

設定できているかは、`.env`を置いた状態で次を確認するのが早い。

- `https://<プロジェクト>.supabase.co/auth/v1/settings` に anon key を付けて GET → `external.anonymous_users` が `true`
- `/rest/v1/scores?select=id&limit=1` が 200（404なら`schema.sql`が未実行）

## 運用メモ
- クイズデータ（quiz_points.json・画像）は完全に静的配信のため、DB障害時もゲーム本体は動作する（機能Kの受け入れ条件）
- Supabase無料枠の範囲で運用（スコアレコードのみで容量は小さい想定）
- 前処理パイプライン（`pipeline/`）はCI/CDに含めない。ローカルで実行し成果物のみコミットする

## 外部サービスの利用条件
- **国土地理院タイル**：出典表示（「地理院タイル」＋出典URLへのリンク）が必須。地図・3Dビューの両方で常時表示する。また大量アクセスの自粛が要請されているため、タイルのプリフェッチや一括ダウンロードは行わない
- **効果音**：自作または再配布可能なライセンス（CC0等）のみ使用し、出典を`public/sounds/CREDITS.md`に記載する

## 容量予算
GitHub Pagesはリポジトリ1GB・帯域100GB/月が目安。画像は長辺1280px・WebP・1枚200KB以下とし、リポジトリ全体で200MB以内を目標にする。1山あたり50地点なら約10MB。超えそうな場合は画像品質を下げるか、地点数を絞る。
