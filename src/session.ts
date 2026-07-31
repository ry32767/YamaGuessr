/**
 * 出題セッション（機能H：10問チャレンジ / 機能I：全地点制覇）。
 *
 * 画面から切り離した純粋なロジックとして持つ。localStorage への保存もここで組み立て、
 * 画面側は表示と入出力だけを担当する。
 */
import { mountainOf, playablePoints } from './data';
import {
  MAX_SCORE,
  NO_WALK,
  scoreGuess,
  scoreWithTime,
  timeFactor,
  walkSeconds,
  type LatLng,
  type WalkEffort,
} from './scoring';
import type { Progress } from './storage';
import type { GameMode, Mountain, QuizData, QuizPoint, ViewMode } from './types';

/** 10問チャレンジの出題数 */
export const CHALLENGE_COUNT = 10;

export interface Answer {
  pointId: string;
  /** 実際に入る点数（時間の倍率を掛けたあと） */
  points: number;
  /** 正解からの距離 [m] */
  distanceM: number;
  /** 時間の倍率を掛ける前の、距離だけのスコア */
  basePoints: number;
  /** 画面を見ていた実時間 [秒] */
  elapsedS: number;
  /** 3Dビューで歩いた道のり [m]（時間を取る区間だけ） */
  walkDistanceM: number;
  /** その道のりを実際に歩いたときの推定所要時間 [秒] */
  walkSecondsS: number;
  /** 使った時間の合計 [秒]（実時間＋歩いた時間） */
  totalTimeS: number;
  /** その時間でのスコア倍率（1〜0） */
  timeFactor: number;
}

export class SessionError extends Error {}

/** セッションの作り方の指定。 */
export interface SessionOptions {
  /** 出題を1つの山（トラック）に絞る。未指定なら全部の山から */
  mountainId?: string | null;
  /** テストから固定できるようにした乱数 */
  random?: () => number;
}

/** 出題可能な地点が無いときに、なぜ無いのかを画面に出せるようにする。 */
export function describeEmpty(): string {
  return '出題地点がまだありません。pipeline/ で出題データを生成してください。';
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
    if (points.length === 0) throw new SessionError(describeEmpty());
    this.points = points;
    this.answers = answers;
    this.cursor = answers.length;
  }

  /**
   * ランダムに重複なく10問（総数が10未満なら全問）。
   *
   * **どの10問を出すかはランダム。出す順番はGPXルートの順。**
   * 山を行ったり来たりする出題にすると、地形図の同じ場所を何度も探し直すことになり、
   * 「歩いた記憶をたどる」というこのゲームの手がかりが働かない。
   * 並びの正は出題データの並び（`quiz_points.json` は山ごとにルート順・docs/data-model.md）。
   */
  static challenge(
    data: QuizData,
    viewMode: ViewMode,
    options: SessionOptions = {},
  ): QuizSession {
    const random = options.random ?? Math.random;
    const pool = playablePoints(data, options.mountainId);
    const order = new Map(pool.map((point, i) => [point.id, i]));
    const picked = shuffled(pool, random)
      .slice(0, Math.min(CHALLENGE_COUNT, pool.length))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return new QuizSession(data, 'challenge10', viewMode, picked);
  }

  /** 全地点を1問ずつ。順序は固定（＝ルート順）で、再開しても変わらない。 */
  static completeAll(
    data: QuizData,
    viewMode: ViewMode,
    options: SessionOptions = {},
  ): QuizSession {
    return new QuizSession(
      data,
      'complete_all',
      viewMode,
      playablePoints(data, options.mountainId),
    );
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
    // 時間の仕組みが無かった頃の進捗も読めるようにする（欠けた項目は埋める）
    const answers = progress.answers.slice(0, points.length).map((a) => ({
      ...a,
      basePoints: a.basePoints ?? a.points,
      elapsedS: a.elapsedS ?? 0,
      walkDistanceM: a.walkDistanceM ?? 0,
      walkSecondsS: a.walkSecondsS ?? 0,
      totalTimeS: a.totalTimeS ?? 0,
      timeFactor: a.timeFactor ?? 1,
    }));
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

  /**
   * 推測を採点して記録する。次の問題へは進めない（結果表示を挟むため）。
   *
   * **点数は「距離のスコア × 時間の倍率」**（機能E-2）。時間は
   * *画面を見ていた実時間* と *3Dで歩いたぶんの推定所要時間* の合計で、
   * 持ち時間（5分）を使い切ると0点になる。その場で読めるほど高得点。
   *
   * @param walk 3Dビューで歩いた量（時間を取る区間だけ）
   * @param elapsedS この問題を表示してからの実時間 [秒]
   */
  submit(guess: LatLng, walk: WalkEffort = NO_WALK, elapsedS = 0): Answer {
    const point = this.current();
    if (!point) throw new SessionError('出題が終わっています');
    const mountain = mountainOf(this.data, point);
    const { distanceM, score } = scoreGuess(
      { lat: point.lat, lon: point.lon },
      guess,
      mountain.max_distance_m,
      mountain.scoring_k,
    );
    const walkS = walkSeconds(walk);
    const totalTimeS = Math.max(0, elapsedS) + walkS;
    const answer: Answer = {
      pointId: point.id,
      points: scoreWithTime(score, totalTimeS),
      distanceM,
      basePoints: score,
      elapsedS: Math.max(0, elapsedS),
      walkDistanceM: walk.distanceM,
      walkSecondsS: walkS,
      totalTimeS,
      timeFactor: timeFactor(totalTimeS),
    };
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
