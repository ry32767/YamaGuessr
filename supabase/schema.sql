-- YamaGuessr スコアDB スキーマ（Supabase / Postgres）
-- 正はこのファイル。構造の説明は docs/data-model.md。
-- Supabase の SQL Editor でそのまま実行する。

-- ---------------------------------------------------------------------------
-- players: 匿名認証したプレイヤーとニックネーム
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 20),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- scores: 1セッション（10問チャレンジ／全地点制覇）の結果
-- anon key は公開されるため、点数の物理的上限は DB 側の CHECK で縛る。
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id               uuid primary key default gen_random_uuid(),
  player_id        uuid not null references public.players (id) on delete cascade,
  mode             text not null check (mode in ('challenge10', 'complete_all')),
  view_mode        text not null check (view_mode in ('map2d', 'terrain3d')),
  point_count      int  not null check (point_count between 1 and 1000),
  points           int  not null check (points >= 0),
  dataset_version  text not null,
  created_at       timestamptz not null default now(),
  -- 満点は 1問5000点 × 出題数
  constraint scores_points_within_max check (points <= 5000 * point_count)
);

create index if not exists scores_ranking_idx
  on public.scores (mode, view_mode, points desc);

-- ---------------------------------------------------------------------------
-- RLS: 読み取りは全員可（リーダーボード表示）、書き込みは本人の行のみ
-- ---------------------------------------------------------------------------
alter table public.players enable row level security;
alter table public.scores  enable row level security;

drop policy if exists players_select_all on public.players;
create policy players_select_all on public.players
  for select using (true);

drop policy if exists players_insert_self on public.players;
create policy players_insert_self on public.players
  for insert with check (id = auth.uid());

drop policy if exists players_update_self on public.players;
create policy players_update_self on public.players
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists scores_select_all on public.scores;
create policy scores_select_all on public.scores
  for select using (true);

drop policy if exists scores_insert_self on public.scores;
create policy scores_insert_self on public.scores
  for insert with check (player_id = auth.uid());

-- スコアの改ざん・削除は誰にも許可しない（update / delete ポリシーを作らない）

-- ---------------------------------------------------------------------------
-- リーダーボード用ビュー
--   challenge10  : 生スコア降順
--   complete_all : 達成率（points / (5000 * point_count)）降順
-- ---------------------------------------------------------------------------
create or replace view public.leaderboard as
select
  s.id,
  s.mode,
  s.view_mode,
  s.points,
  s.point_count,
  s.dataset_version,
  s.created_at,
  p.nickname,
  (s.points::float / (5000 * s.point_count)) as achievement_rate
from public.scores s
join public.players p on p.id = s.player_id;
