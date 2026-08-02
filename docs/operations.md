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
2. **SQL Editor で`supabase/schema.sql`を実行**して`players`/`scores`テーブル・RLS・`leaderboard`ビューを作る
3. **メールログインを設定する**（下記）
4. プロジェクトURL・anon keyを`.env`（ローカル）とGitHub Actions Secrets（ビルド時に埋め込み）双方に設定する

### メールログインの設定
認証は**メールアドレス＋パスワード**（機能K）。外部プロバイダへ遷移しないので、**URL Configuration の登録は不要**。

**ダッシュボードでの設定で、SQLでは設定できない**（認証の構成はDBではなくAuthの管轄のため）。

1. **Supabase** → Authentication → Sign In / Providers → **Email** が有効になっていることを確認する（既定で有効）
2. 同じ画面で **「Confirm email」をOFFにする** ← **これをやらないと登録できない**
3. 匿名サインインとGoogleを含む外部プロバイダは使わない。有効にする必要はない

> **なぜ「Confirm email」をOFFにするのか**：無料枠の既定SMTPは**2通/時**でテスト用途と明記されており、
> ONのままだと数人が同時に登録しようとした時点で詰まる。メールアドレスは記録を引き継ぐIDとしてしか
> 使わず、通知も送らないので所有確認をしなくても実害が小さい——という判断（[spec.md](spec.md) 機能K）。
>
> **カスタムSMTP（Resend等）を入れるならONに戻してよい。** アプリ側は両対応で、ONのときは
> 登録直後にセッションが返らないことを検出して「確認メールを送りました」と案内する（`AuthOutcome.pending`）。

設定できているかは、`.env`を置いた状態で次を確認するのが早い。

- `/rest/v1/scores?select=id&limit=1` が 200（404なら`schema.sql`が未実行）
- `/rest/v1/leaderboard?select=id,nickname,points&limit=1` が 200（ビューまで作れているか）
- `https://<プロジェクト>.supabase.co/auth/v1/settings` に anon key を付けて GET → `external.email` が `true`、
  かつ **`mailer_autoconfirm` が `true`**（`false`なら「Confirm email」がONのまま。この状態でも**取得は通り、登録・送信だけができない**）

### スキーマを変えたあと
**`supabase/schema.sql`を直したら、ダッシュボードのSQL Editorで貼り直して実行する**（このファイルが正で、MCPから直接流し込まない）。全体が`create ... if not exists` / `create or replace` / `drop policy if exists`で書いてあるので、何度実行しても同じ状態になる。

実行後は**Advisorsを必ず見る**（Database → Advisors、またはMCPの`get_advisors`）。ERRORが1件でも残っていたら直す。過去に踏んだもの：

| 指摘 | 原因 | 対処 |
|---|---|---|
| `security_definer_view` | ビューに`security_invoker`を付けないと作成者権限で動き、RLSを素通りする | `create or replace view public.leaderboard with (security_invoker = true) as ...` |

## Supabase MCPサーバ（AIエージェント用・任意）
Claude Code等からSupabaseのスキーマ・ログ・アドバイザを直接読めるようにする設定を[.mcp.json](../.mcp.json)に置いてある。Supabase公式の**ホスト版（HTTP + OAuth）**を使う。**アプリの動作には一切関係しない**（開発時の調査用）。

```json
{ "mcpServers": { "supabase": { "type": "http",
  "url": "https://mcp.supabase.com/mcp?project_ref=<プロジェクトref>&features=..." } } }
```

- **鍵はファイルに書かない。** 認証はOAuthで、トークンはエディタ側に保存される（`.mcp.json`にはURLしか入らないのでコミットして問題ない）
- `project_ref`でプロジェクトを固定している。**リポジトリのSupabaseプロジェクトを作り直したらここも変える**
- 使うには一度だけ認証が必要。**IDE拡張ではなく通常のターミナル**で`claude`を起動し、`/mcp`から`supabase`を選んでAuthenticateする
- 読み取り専用にしたい場合はURLに`&read_only=true`を付ける（スキーマ変更を`supabase/schema.sql`＋ダッシュボード運用に限定したいとき）。ただし**OAuthで要求される権限自体は書き込みを含む**ため、これはMCPツール側の制限であって権限の制限ではない

### Agent Skills
Supabase公式のスキル2つ（`supabase` / `supabase-postgres-best-practices`）を導入済み。実体は`node_modules`と同じ扱いでコミットせず、[skills-lock.json](../skills-lock.json)から復元する。

```bash
npx skills experimental_install   # skills-lock.json から .agents/skills/ を復元し、.claude/skills/ に張る
npx skills list                   # 導入済みスキルの確認
npx skills update                 # 更新（skills-lock.json のハッシュが変わる＝コミット対象）
```

## 運用メモ
- クイズデータ（quiz_points.json・画像）は完全に静的配信のため、DB障害時もゲーム本体は動作する（機能Kの受け入れ条件）
- Supabase無料枠の範囲で運用（スコアレコードのみで容量は小さい想定）
- 前処理パイプライン（`pipeline/`）はCI/CDに含めない。ローカルで実行し成果物のみコミットする

## 外部サービスの利用条件
- **国土地理院タイル**：出典表示（「地理院タイル」＋出典URLへのリンク）が必須。地図・3Dビューの両方で常時表示する。また大量アクセスの自粛が要請されているため、タイルのプリフェッチや一括ダウンロードは行わない
- **効果音**：自作または再配布可能なライセンス（CC0等）のみ使用し、出典を`public/sounds/CREDITS.md`に記載する

## 容量予算
GitHub Pagesはリポジトリ1GB・帯域100GB/月が目安。画像は長辺1280px・WebP・1枚200KB以下とし、リポジトリ全体で200MB以内を目標にする。1山あたり50地点なら約10MB。超えそうな場合は画像品質を下げるか、地点数を絞る。
