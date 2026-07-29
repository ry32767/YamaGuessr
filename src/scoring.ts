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
