/**
 * 効果音（機能J）。
 *
 * 音源ファイルは持たず、Web Audio API で**その場で合成**する。
 * 自作なのでライセンス上の制約がなく、配信する容量も増えない
 * （出典は public/sounds/CREDITS.md）。
 */
import { loadSettings, saveSettings } from './storage';

type Voice = { freq: number; start: number; duration: number; gain?: number };

/** 正解（4000点以上）。上向きの明るい3音。 */
const CORRECT: Voice[] = [
  { freq: 784, start: 0, duration: 0.12 },
  { freq: 988, start: 0.09, duration: 0.12 },
  { freq: 1319, start: 0.18, duration: 0.3 },
];

/** それ以外。下向きの短い2音（失敗を責めない程度に控えめ）。 */
const MISS: Voice[] = [
  { freq: 392, start: 0, duration: 0.11, gain: 0.5 },
  { freq: 294, start: 0.1, duration: 0.22, gain: 0.5 },
];

/** セッション完了。少し長い上昇形。 */
const FINISH: Voice[] = [
  { freq: 523, start: 0, duration: 0.14 },
  { freq: 659, start: 0.13, duration: 0.14 },
  { freq: 784, start: 0.26, duration: 0.14 },
  { freq: 1047, start: 0.39, duration: 0.45 },
];

export type SoundName = 'correct' | 'miss' | 'finish';

const VOICES: Record<SoundName, Voice[]> = {
  correct: CORRECT,
  miss: MISS,
  finish: FINISH,
};

/** この点数以上なら正解音（docs/spec.md 機能J） */
export const CORRECT_THRESHOLD = 4000;

let context: AudioContext | null = null;
let enabled = loadSettings().soundEnabled;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/** ON/OFF を切り替えて localStorage に保存する。戻り値は切り替え後の状態。 */
export function setSoundEnabled(next: boolean): boolean {
  enabled = next;
  saveSettings({ soundEnabled: next });
  return enabled;
}

export function toggleSound(): boolean {
  return setSoundEnabled(!enabled);
}

/** 効果音を鳴らす。OFF のときは何も鳴らさない。 */
export function play(name: SoundName): void {
  if (!enabled) return;
  const ctx = audioContext();
  if (!ctx) return;
  // 自動再生制限で suspended のことがある
  void ctx.resume?.();

  const now = ctx.currentTime;
  for (const voice of VOICES[name]) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(voice.freq, now + voice.start);

    const peak = 0.16 * (voice.gain ?? 1);
    amp.gain.setValueAtTime(0.0001, now + voice.start);
    amp.gain.exponentialRampToValueAtTime(peak, now + voice.start + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + voice.start + voice.duration);

    osc.connect(amp).connect(ctx.destination);
    osc.start(now + voice.start);
    osc.stop(now + voice.start + voice.duration + 0.02);
  }
}

/** 1問の結果に応じた効果音を選ぶ。 */
export function playForScore(points: number): void {
  play(points >= CORRECT_THRESHOLD ? 'correct' : 'miss');
}
