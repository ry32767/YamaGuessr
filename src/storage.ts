/** localStorage に置く設定と進捗。壊れた値が入っていても既定値に落として続行する。 */
import type { GameMode, ViewMode } from './types';

const KEY_SETTINGS = 'yamaguessr.settings.v1';
const KEY_PROGRESS = 'yamaguessr.progress.v1';

export interface Settings {
  /** 効果音を鳴らすか（機能J） */
  soundEnabled: boolean;
  nickname: string | null;
}

const DEFAULT_SETTINGS: Settings = { soundEnabled: true, nickname: null };

/** 全地点制覇モードの途中経過（機能I）。 */
export interface Progress {
  mode: GameMode;
  viewMode: ViewMode;
  /** このデータで作った進捗か判定するための版 */
  datasetVersion: string;
  /** 出題順（point id） */
  order: string[];
  /** 回答済みの結果 */
  answers: { pointId: string; points: number; distanceM: number }[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // プライベートブラウジング等で書けなくても、ゲーム本体は動かす
  }
}

export function loadSettings(): Settings {
  return read<Settings>(KEY_SETTINGS, DEFAULT_SETTINGS);
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  write(KEY_SETTINGS, next);
  return next;
}

export function loadProgress(): Progress | null {
  try {
    const raw = localStorage.getItem(KEY_PROGRESS);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Progress>;
    if (!value.order || !value.answers || !value.datasetVersion) return null;
    return value as Progress;
  } catch {
    return null;
  }
}

export function saveProgress(progress: Progress): void {
  write(KEY_PROGRESS, progress);
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY_PROGRESS);
  } catch {
    /* 無視して続行 */
  }
}
