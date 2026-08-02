/**
 * Supabase（機能K：メールログイン・ニックネーム / 機能L：リーダーボード）。
 *
 * **Supabaseに繋がらなくてもゲーム本体は最後まで動く**（docs/spec.md 機能K）。
 * このモジュールは失敗しても例外を投げっぱなしにせず、呼び出し側が
 * 「リーダーボードだけ無効」に落とせる形で結果を返す。
 *
 * 認証は**メールアドレス＋パスワード**。外部プロバイダへ遷移しないので
 * リダイレクトURLの登録が要らず、ローカルでもGitHub Pagesでも同じ経路で動く。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadSettings, saveSettings } from './storage';
import type { GameMode, ViewMode } from './types';

export const NICKNAME_MAX = 20;

/** Supabaseの既定の最小パスワード長。ここを変えるならダッシュボード側も変える。 */
export const PASSWORD_MIN = 6;

/** 認証操作の結果。例外は投げず、必ずこの形で返す。 */
export interface AuthOutcome {
  /** サインイン済みになったか */
  ok: boolean;
  /**
   * 確認メール待ちか。
   * ダッシュボードで「Confirm email」がONのとき、登録直後はセッションが返らない。
   * OFF運用が既定だが、ONに戻されても画面が黙り込まないようにここで区別する。
   */
  pending: boolean;
  /** 画面に出す日本語メッセージ。成功時はnull */
  message: string | null;
}

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
      // 外部プロバイダへ飛ばさないので、URLからトークンを拾う必要が無い
      detectSessionInUrl: false,
    },
  });
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
 * メールアドレスの形式チェック。
 * 厳密な検証はサーバに任せ、ここは打ち間違いを即座に返すためだけの緩い判定にする。
 */
export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'メールアドレスを入力してください';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'メールアドレスの形式が正しくありません';
  return null;
}

export function validatePassword(value: string): string | null {
  if (value.length === 0) return 'パスワードを入力してください';
  if (value.length < PASSWORD_MIN) return `パスワードは${PASSWORD_MIN}文字以上にしてください`;
  return null;
}

/**
 * Supabaseの英語エラーを日本語にする（UI文言は日本語・AGENTS.md）。
 * 未知のメッセージは原文を添えて返す——黙って潰すと原因が追えなくなるため。
 */
export function describeAuthError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('invalid login credentials')) return 'メールアドレスかパスワードが違います';
  // Supabaseは実在しなさそうなドメイン（example.com等）を登録時に弾く
  if (m.includes('email address') && m.includes('invalid')) {
    return 'このメールアドレスは使えません。別のアドレスをお試しください';
  }
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'このメールアドレスは登録済みです。「ログイン」から入ってください';
  }
  if (m.includes('email not confirmed')) {
    return 'メールアドレスの確認が済んでいません。届いた確認メールのリンクを開いてください';
  }
  if (m.includes('password should be at least')) {
    return `パスワードは${PASSWORD_MIN}文字以上にしてください`;
  }
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) {
    return '新規登録が無効になっています';
  }
  if (m.includes('rate limit') || m.includes('too many requests')) {
    return '試行が多すぎます。しばらく待ってからもう一度お試しください';
  }
  if (m.includes('failed to fetch') || m.includes('network')) {
    return 'ネットワークに繋がりませんでした（ゲームはこのまま遊べます）';
  }
  return `ログインできませんでした（${raw}）`;
}

/**
 * 保存されたセッションから復帰する。
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

const NOT_CONFIGURED: AuthOutcome = {
  ok: false,
  pending: false,
  message: 'ログイン機能が設定されていません',
};

function failed(e: unknown): AuthOutcome {
  const raw = e instanceof Error ? e.message : '原因不明のエラー';
  return { ok: false, pending: false, message: describeAuthError(raw) };
}

/**
 * メールアドレスとパスワードで新規登録する。
 *
 * 登録と同時にサインインまで済ませる（ダッシュボードで「Confirm email」をOFFに
 * している前提）。**ONに戻された場合はセッションが返らない**ので、その場合は
 * `pending: true` で「確認メールを見てほしい」と伝える。
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  name: string,
): Promise<AuthOutcome> {
  if (!client) return NOT_CONFIGURED;
  try {
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      // ニックネームをuser_metadataに預ける。確認メール待ちになると`players`を
      // 作れないまま画面を離れるので、ここに残しておかないと入力が捨てられる
      options: { data: { nickname: name.trim().slice(0, NICKNAME_MAX) } },
    });
    if (error) return { ok: false, pending: false, message: describeAuthError(error.message) };
    if (!data.session || !data.user) {
      return {
        ok: false,
        pending: true,
        message: '確認メールを送りました。リンクを開いてから、もう一度ログインしてください',
      };
    }
    playerId = data.user.id;
    await saveNickname(name.trim() || fallbackNickname(data.user.email));
    return { ok: true, pending: false, message: null };
  } catch (e) {
    return failed(e);
  }
}

/** 登録済みのメールアドレスとパスワードでログインする。 */
export async function signInWithEmail(email: string, password: string): Promise<AuthOutcome> {
  if (!client) return NOT_CONFIGURED;
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) return { ok: false, pending: false, message: describeAuthError(error.message) };
    if (!data.user) return { ok: false, pending: false, message: 'ログインできませんでした' };
    playerId = data.user.id;
    await ensurePlayerRow(data.user);
    return { ok: true, pending: false, message: null };
  } catch (e) {
    return failed(e);
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
 * ニックネーム未設定時の初期値。**メールアドレスの@より前**を使う。
 * リーダーボードが「（名前なし）」で埋まらないようにするための保険で、
 * あとからニックネームダイアログで変更できる。
 */
function fallbackNickname(email?: string | undefined): string {
  const local = email ? email.split('@')[0] : '';
  return (local || 'プレイヤー').slice(0, NICKNAME_MAX);
}

/**
 * `players` の行を用意する。優先順位は
 * **サーバ保存済み → 登録時に入力したニックネーム → メールの@より前**。
 *
 * 真ん中があるのは、確認メール待ちで登録が中断した場合に備えるため。
 * その経路では`players`を作れないまま画面を離れるので、あとからログインした
 * ときに`user_metadata`から拾い直す。
 */
async function ensurePlayerRow(user: {
  id: string;
  email?: string | undefined;
  user_metadata?: Record<string, unknown> | undefined;
}): Promise<void> {
  const stored = await syncNickname();
  if (stored) return;
  const fromSignUp = user.user_metadata?.nickname;
  const typed = typeof fromSignUp === 'string' ? fromSignUp.trim() : '';
  await saveNickname(typed || fallbackNickname(user.email));
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
