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
    auth: { persistSession: true, autoRefreshToken: true },
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
 * 匿名サインインしてプレイヤーIDを得る。
 * 2回目以降は端末に保存されたセッションから同一プレイヤーとして復帰する。
 */
export async function signIn(): Promise<string | null> {
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    if (data.session?.user) {
      playerId = data.session.user.id;
      return playerId;
    }
    const { data: created, error } = await client.auth.signInAnonymously();
    if (error || !created.user) return null;
    playerId = created.user.id;
    return playerId;
  } catch {
    return null;
  }
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
    const { data, error } = await client
      .from('leaderboard')
      .select('id, nickname, points, point_count, created_at, achievement_rate, player_id')
      .eq('mode', mode)
      .eq('view_mode', viewMode)
      .order(mode === 'complete_all' ? 'achievement_rate' : 'points', { ascending: false })
      .limit(limit);
    if (error || !data) return null;
    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      nickname: String(row.nickname ?? '（名前なし）'),
      points: Number(row.points ?? 0),
      point_count: Number(row.point_count ?? 0),
      created_at: String(row.created_at ?? ''),
      achievement_rate: Number(row.achievement_rate ?? 0),
      isMe: playerId !== null && row.player_id === playerId,
    }));
  } catch {
    return null;
  }
}
