/**
 * Supabase（機能K：匿名認証・ニックネーム / 機能L：リーダーボード）。
 *
 * **Supabaseに繋がらなくてもゲーム本体は最後まで動く**（docs/spec.md 機能K）。
 * このモジュールは失敗しても例外を投げっぱなしにせず、呼び出し側が
 * 「リーダーボードだけ無効」に落とせる形で結果を返す。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadSettings, saveSettings } from './storage';
import type { GameMode, ViewMode } from './types';

export const NICKNAME_MAX = 20;

export interface ScoreRecord {
  mode: GameMode;
  view_mode: ViewMode;
  points: number;
  point_count: number;
  dataset_version: string;
}

export interface RankingRow {
  id: string;
  nickname: string;
  points: number;
  point_count: number;
  created_at: string;
  achievement_rate: number;
  isMe: boolean;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;
if (url && anonKey) {
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Googleから戻ってきたURLに乗っているトークンを拾ってセッションにする
      detectSessionInUrl: true,
    },
  });
}

/**
 * ログイン後に戻ってくるURL。
 *
 * GitHub Pages ではサブパス配信（`/YamaGuessr/`）なので `BASE_URL` を足す。
 * **この値を Supabase の Authentication → URL Configuration の
 * Redirect URLs に登録しておく**（登録が無いとログイン後に弾かれる）。
 */
function redirectUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

/** 環境変数が設定されているか。未設定ならリーダーボードUIごと隠す。 */
export function isConfigured(): boolean {
  return client !== null;
}

let playerId: string | null = null;

/** 現在のプレイヤーID。未サインインなら null。 */
export function currentPlayerId(): string | null {
  return playerId;
}

/** ニックネーム。Supabaseが使えない場合は「ゲスト」。 */
export function nickname(): string {
  return loadSettings().nickname ?? 'ゲスト';
}

export function validateNickname(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'ニックネームを入力してください';
  if (trimmed.length > NICKNAME_MAX) return `${NICKNAME_MAX}文字以内で入力してください`;
  return null;
}

/**
 * 保存されたセッションから復帰する（Googleから戻ってきた直後もここで拾う）。
 *
 * **ログインしていなくてもゲームは最後まで遊べる**（DESIGN.md 不変条件7）。
 * ログインは「記録を残したい人だけが押すもの」で、起動時に強制しない。
 */
export async function restoreSession(): Promise<string | null> {
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    playerId = user.id;
    await ensurePlayerRow(user);
    return playerId;
  } catch {
    return null;
  }
}

/** ログイン済みか。リーダーボードに記録できるかの判定に使う。 */
export function isSignedIn(): boolean {
  return playerId !== null;
}

/**
 * ログインから戻ってきたURLにエラーが乗っていれば取り出す（1回だけ）。
 *
 * Googleプロバイダが未設定のときなどは、**エラーがURLに載って戻ってくる**。
 * 黙って握りつぶすと「押しても何も起きない」ように見えるので、画面に出す。
 */
export function takeAuthError(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromQuery = new URLSearchParams(window.location.search);
  const message =
    fromHash.get('error_description') ??
    fromQuery.get('error_description') ??
    fromHash.get('error') ??
    fromQuery.get('error');
  if (!message) return null;
  // 同じエラーを再読み込みのたびに出さないよう、URLから消しておく
  window.history.replaceState(null, '', window.location.pathname);
  return decodeURIComponent(message.replace(/\+/g, ' '));
}

/**
 * Googleでログインする。**この関数を呼ぶとGoogleの画面へ遷移する**（戻り値は返らない）。
 * 戻ってきたときに `restoreSession()` がセッションを拾う。
 */
export async function signInWithGoogle(): Promise<string | null> {
  if (!client) return 'ログイン機能が設定されていません';
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl() },
    });
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : 'ログインを開始できませんでした';
  }
}

export async function signOut(): Promise<void> {
  playerId = null;
  saveSettings({ nickname: null });
  if (!client) return;
  try {
    await client.auth.signOut();
  } catch {
    // 通信できなくてもローカルのログイン状態は落とす
  }
}

/**
 * `players` の行を用意する。**Googleの表示名を初期ニックネームにする**
 * （リーダーボードに「（名前なし）」が並ばないように）。
 */
async function ensurePlayerRow(user: { id: string; user_metadata?: Record<string, unknown>; email?: string | undefined }): Promise<void> {
  const stored = await syncNickname();
  if (stored) return;
  const meta = user.user_metadata ?? {};
  const fromGoogle =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    (user.email ? user.email.split('@')[0] : null);
  await saveNickname((fromGoogle ?? 'プレイヤー').slice(0, NICKNAME_MAX));
}

/** ニックネームを保存する。ローカルには必ず、Supabaseには繋がれば。 */
export async function saveNickname(name: string): Promise<boolean> {
  const trimmed = name.trim();
  saveSettings({ nickname: trimmed });
  if (!client || !playerId) return false;
  try {
    const { error } = await client
      .from('players')
      .upsert({ id: playerId, nickname: trimmed }, { onConflict: 'id' });
    return !error;
  } catch {
    return false;
  }
}

/** サーバに保存済みのニックネームを引いて、ローカルに反映する。 */
export async function syncNickname(): Promise<string | null> {
  if (!client || !playerId) return null;
  try {
    const { data, error } = await client
      .from('players')
      .select('nickname')
      .eq('id', playerId)
      .maybeSingle();
    if (error || !data) return null;
    const name = (data as { nickname: string }).nickname;
    saveSettings({ nickname: name });
    return name;
  } catch {
    return null;
  }
}

/** スコアを送信する。失敗しても例外にせず false を返す（結果画面は出す）。 */
export async function submitScore(record: ScoreRecord): Promise<boolean> {
  if (!client || !playerId) return false;
  try {
    const { error } = await client.from('scores').insert({ ...record, player_id: playerId });
    return !error;
  } catch {
    return false;
  }
}

/**
 * ランキングを取る。
 * `challenge10` は生スコア降順、`complete_all` は**達成率降順**
 * （地点数が増えても過去記録と比較できるようにするため）。
 */
export async function fetchRanking(
  mode: GameMode,
  viewMode: ViewMode,
  limit = 20,
): Promise<RankingRow[] | null> {
  if (!client) return null;
  try {
    // **`leaderboard` ビューに `player_id` は無い**（誰のスコアかを公開しないため）。
    // 自分の行に印を付けるのは、自分のスコアIDを別に引いて突き合わせる
    const { data, error } = await client
      .from('leaderboard')
      .select('id, nickname, points, point_count, created_at, achievement_rate')
      .eq('mode', mode)
      .eq('view_mode', viewMode)
      .order(mode === 'complete_all' ? 'achievement_rate' : 'points', { ascending: false })
      .limit(limit);
    if (error || !data) return null;
    const mine = await myScoreIds();
    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      nickname: String(row.nickname ?? '（名前なし）'),
      points: Number(row.points ?? 0),
      point_count: Number(row.point_count ?? 0),
      created_at: String(row.created_at ?? ''),
      achievement_rate: Number(row.achievement_rate ?? 0),
      isMe: mine.has(String(row.id)),
    }));
  } catch {
    return null;
  }
}

/** 自分が出したスコアのID。ランキングで自分の行を目立たせるためだけに使う。 */
async function myScoreIds(): Promise<Set<string>> {
  if (!client || !playerId) return new Set();
  try {
    const { data, error } = await client.from('scores').select('id').eq('player_id', playerId);
    if (error || !data) return new Set();
    return new Set((data as Array<{ id: string }>).map((row) => String(row.id)));
  } catch {
    return new Set();
  }
}
