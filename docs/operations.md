# デプロイ・運用

| 変数 | 用途 | 例 |
|---|---|---|
| `VITE_SUPABASE_URL` | SupabaseプロジェクトURL | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key（公開前提、RLSで保護） | `eyJ...` |

> 実値はコミットしない（`.env.example`に雛形）。anon keyはブラウザに露出する前提の鍵であり、書き込み制御は`supabase/schema.sql`のRLSポリシーで行う（service_role keyは絶対にフロントに置かない）。

## デプロイ手順（GitHub Pages + GitHub Actions）
1. `main`ブランチへのpushをトリガーに`npm run build`
2. ビルド成果物（`dist/`）を`gh-pages`ブランチへpublish
3. GitHub Pagesの公開設定を`gh-pages`ブランチ・ルートに設定

## Supabase初期セットアップ
1. Supabaseプロジェクトを作成し、Authで匿名サインインを有効化
2. `supabase/schema.sql`を実行して`players`/`scores`テーブルとRLSポリシーを作成
3. プロジェクトURL・anon keyを`.env`（ローカル）とGitHub Actions Secrets（ビルド時に埋め込み）双方に設定

## 運用メモ
- クイズデータ（quiz_points.json・画像）は完全に静的配信のため、DB障害時もゲーム本体は動作する（機能Kの受け入れ条件）
- Supabase無料枠の範囲で運用（スコアレコードのみで容量は小さい想定）
- 前処理パイプライン（`pipeline/`）はCI/CDに含めない。ローカルで実行し成果物のみコミットする

## 外部サービスの利用条件
- **国土地理院タイル**：出典表示（「地理院タイル」＋出典URLへのリンク）が必須。地図・3Dビューの両方で常時表示する。また大量アクセスの自粛が要請されているため、タイルのプリフェッチや一括ダウンロードは行わない
- **効果音**：自作または再配布可能なライセンス（CC0等）のみ使用し、出典を`public/sounds/CREDITS.md`に記載する

## 容量予算
GitHub Pagesはリポジトリ1GB・帯域100GB/月が目安。画像は長辺1280px・WebP・1枚200KB以下とし、リポジトリ全体で200MB以内を目標にする。1山あたり50地点なら約10MB。超えそうな場合は画像品質を下げるか、地点数を絞る。
