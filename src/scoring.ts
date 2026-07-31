/**
 * スコア計算（機能E）。
 *
 * 正解地点と推測地点の距離からGeoGuessr風のスコア（0〜5000点）を求める。
 * 計算式は docs/spec.md の受け入れ条件に一致させること。
 */

/** 地球の平均半径 [m]（WGS84の平均） */
const EARTH_RADIUS_M = 6371008.8;

/** 満点 */
export const MAX_SCORE = 5000;

/** 緯度経度（度） */
export interface LatLng {
  readonly lat: number;
  readonly lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 2地点間の大円距離 [m]（haversine）。
 * 出題範囲は数km程度なので、この近似で十分な精度がある。
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 距離 [m] からスコアを求める。
 *
 * `d >= maxDistanceM` のとき 0、それ以外は
 * `round(5000 * (exp(-k*d/max) - exp(-k)) / (1 - exp(-k)))`。
 * d = max で厳密に 0 になるよう `exp(-k)` を引いて正規化しているため、
 * 上限の直前で点数が飛ぶ不連続点がない。
 *
 * @param distanceM 正解との距離 [m]（負値は 0 として扱う）
 * @param maxDistanceM これ以上離れると 0 点になる距離 [m]（Mountain.max_distance_m）
 * @param k 減衰の急峻さ（Mountain.scoring_k、既定4。大きいほど厳しい）
 */
export function scoreForDistance(
  distanceM: number,
  maxDistanceM: number,
  k = 4,
): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(maxDistanceM)) {
    throw new RangeError('distanceM と maxDistanceM は有限の数値である必要があります');
  }
  if (maxDistanceM <= 0) {
    throw new RangeError('maxDistanceM は正の数である必要があります');
  }
  if (k <= 0) {
    throw new RangeError('k は正の数である必要があります');
  }

  const d = Math.max(0, distanceM);
  if (d >= maxDistanceM) return 0;

  const expNegK = Math.exp(-k);
  const raw = (Math.exp((-k * d) / maxDistanceM) - expNegK) / (1 - expNegK);
  return Math.round(MAX_SCORE * raw);
}

/** 正解地点と推測地点からスコアと距離をまとめて返す。 */
export function scoreGuess(
  actual: LatLng,
  guess: LatLng,
  maxDistanceM: number,
  k = 4,
): { distanceM: number; score: number } {
  const distanceM = distanceMeters(actual, guess);
  return { distanceM, score: scoreForDistance(distanceM, maxDistanceM, k) };
}

// ---------------------------------------------------------------------------
// 移動のコスト（機能E-2）
// ---------------------------------------------------------------------------
/**
 * 3Dビューでルートを歩いた量。**歩いた道のり**（往復すれば足し算）と、
 * その間の累積の登り・下り。
 */
export interface WalkEffort {
  distanceM: number;
  ascentM: number;
  descentM: number;
}

export const NO_WALK: WalkEffort = { distanceM: 0, ascentM: 0, descentM: 0 };

/**
 * 歩く速さの目安。**実際に山を歩いたらどれくらいかかるか**を出すための値で、
 * 登山地図の標準コースタイム（水平4km/h・登り350m/h・下り500m/h）に合わせている。
 * 平地の距離と登り下りを足し合わせる素朴な式だが、
 * 「登り返しは高くつく」という山の感覚は再現できる。
 */
export const WALK_SPEED_M_PER_MIN = 4000 / 60;
export const ASCENT_M_PER_MIN = 350 / 60;
export const DESCENT_M_PER_MIN = 500 / 60;

/** 歩いた道のりを、実際に山で歩いたときの所要時間 [分] に直す。 */
export function hikingMinutes(effort: WalkEffort): number {
  return (
    Math.max(0, effort.distanceM) / WALK_SPEED_M_PER_MIN +
    Math.max(0, effort.ascentM) / ASCENT_M_PER_MIN +
    Math.max(0, effort.descentM) / DESCENT_M_PER_MIN
  );
}

/** 歩いた道のりを、実際に山で歩いたときの所要時間 [秒] に直す。 */
export function walkSeconds(effort: WalkEffort): number {
  return hikingMinutes(effort) * 60;
}

// ---------------------------------------------------------------------------
// 時間（機能E-2）
// ---------------------------------------------------------------------------
/**
 * 持ち時間 [秒]。**これを使い切ると0点**。
 *
 * 「その場の地形を読んで当てる」ゲームなので、考え込むほど・歩き回るほど
 * 点が減る。5分あれば見回して地形図を突き合わせるには十分で、
 * 「とりあえず全部歩いてみる」は割に合わない、という重さに置いた。
 */
export const TIME_LIMIT_S = 300;

/**
 * 使った時間 [秒] に対するスコアの倍率（1→0）。
 *
 * **直線で減らす。** 指数だと最初の数十秒でごっそり減って理不尽に見えるうえ、
 * 残り時間バーの見た目と実際の減りが合わない。直線なら
 * 「バーが半分＝点も半分」で、画面を見たまま判断できる。
 */
export function timeFactor(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.min(1, 1 - Math.max(0, seconds) / TIME_LIMIT_S));
}

/** 距離のスコアに、使った時間の倍率を掛けた最終得点。 */
export function scoreWithTime(basePoints: number, seconds: number): number {
  return Math.round(Math.max(0, basePoints) * timeFactor(seconds));
}

/** 残り時間 [秒]。 */
export function remainingSeconds(seconds: number): number {
  return Math.max(0, TIME_LIMIT_S - Math.max(0, seconds));
}

/** `秒 → "m:ss"`。タイマー表示に使う。 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
