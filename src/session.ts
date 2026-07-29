/**
 * 出題セッション（機能H：10問チャレンジ / 機能I：全地点制覇）。
 *
 * 画面から切り離した純粋なロジックとして持つ。localStorage への保存もここで組み立て、
 * 画面側は表示と入出力だけを担当する。
 */
import { mountainOf, playablePoints } from './data';
import { MAX_SCORE, scoreGuess, type LatLng } from './scoring';
import type { Progress } from './storage';
import type { GameMode, Mountain, QuizData, QuizPoint, ViewMode } from './types';

/** 10問チャレンジの出題数 */
export const CHALLENGE_COUNT = 10;

export interface Answer {
  pointId: string;
  points: number;
  distanceM: number;
}

export class SessionError extends Error {}

/** 出題可能な地点が無いときに、なぜ無いのかを画面に出せるようにする。 */
export function describeEmpty(viewMode: ViewMode): string {
  return viewMode === 'map2d'
    ? '画像付きの出題地点がまだありません。3D地形モードなら遊べる地点があるかもしれません。'
    : '出題地点がまだありません。pipeline/ で出題データを生成してください。';
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export class QuizSession {
  private readonly points: QuizPoint[];
  private readonly answers: Answer[];
  private cursor: number;

  private constructor(
    readonly data: QuizData,
    readonly mode: GameMode,
    readonly viewMode: ViewMode,
    points: QuizPoint[],
    answers: Answer[] = [],
  ) {
    if (points.length === 0) throw new SessionError(describeEmpty(viewMode));
    this.points = points;
    this.answers = answers;
    this.cursor = answers.length;
  }

  /** ランダムに重複なく10問（総数が10未満なら全問）。 */
  static challenge(
    data: QuizData,
    viewMode: ViewMode,
    random: () => number = Math.random,
  ): QuizSession {
    const pool = playablePoints(data, viewMode);
    const picked = shuffled(pool, random).slice(0, Math.min(CHALLENGE_COUNT, pool.length));
    return new QuizSession(data, 'challenge10', viewMode, picked);
  }

  /** 全地点を1問ずつ。順序は固定（山→id順）で、再開しても変わらない。 */
  static completeAll(data: QuizData, viewMode: ViewMode): QuizSession {
    const pool = [...playablePoints(data, viewMode)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return new QuizSession(data, 'complete_all', viewMode, pool);
  }

  /**
   * 保存された進捗から再開する。
   * データが差し替わって地点が消えている場合は再開できない（null を返す）。
   */
  static resume(data: QuizData, progress: Progress): QuizSession | null {
    const byId = new Map(data.points.map((p) => [p.id, p]));
    const points: QuizPoint[] = [];
    for (const id of progress.order) {
      const point = byId.get(id);
      if (!point) return null;
      points.push(point);
    }
    if (points.length === 0) return null;
    const answers = progress.answers.slice(0, points.length);
    return new QuizSession(data, progress.mode, progress.viewMode, points, answers);
  }

  get total(): number {
    return this.points.length;
  }

  /** 0始まりの現在位置。 */
  get index(): number {
    return this.cursor;
  }

  get answered(): readonly Answer[] {
    return this.answers;
  }

  get finished(): boolean {
    return this.cursor >= this.points.length;
  }

  current(): QuizPoint | null {
    return this.points[this.cursor] ?? null;
  }

  currentMountain(): Mountain | null {
    const point = this.current();
    return point ? mountainOf(this.data, point) : null;
  }

  /** 推測を採点して記録する。次の問題へは進めない（結果表示を挟むため）。 */
  submit(guess: LatLng): Answer {
    const point = this.current();
    if (!point) throw new SessionError('出題が終わっています');
    const mountain = mountainOf(this.data, point);
    const { distanceM, score } = scoreGuess(
      { lat: point.lat, lon: point.lon },
      guess,
      mountain.max_distance_m,
      mountain.scoring_k,
    );
    const answer: Answer = { pointId: point.id, points: score, distanceM };
    this.answers.push(answer);
    return answer;
  }

  /** 次の問題へ。最後まで来ていたら false。 */
  advance(): boolean {
    if (this.finished) return false;
    this.cursor += 1;
    return !this.finished;
  }

  get totalPoints(): number {
    return this.answers.reduce((sum, a) => sum + a.points, 0);
  }

  /** 達成率（合計 ÷ 5000×出題数）。全地点制覇のランキングはこれで並べる。 */
  get achievementRate(): number {
    if (this.points.length === 0) return 0;
    return this.totalPoints / (MAX_SCORE * this.points.length);
  }

  pointAt(index: number): QuizPoint | null {
    return this.points[index] ?? null;
  }

  toProgress(): Progress {
    return {
      mode: this.mode,
      viewMode: this.viewMode,
      datasetVersion: this.data.dataset_version,
      order: this.points.map((p) => p.id),
      answers: [...this.answers],
    };
  }
}
