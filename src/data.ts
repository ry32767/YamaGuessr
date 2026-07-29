/** 出題データ（public/data/quiz_points.json）の読み込みと参照。 */
import type { Mountain, QuizData, QuizPoint } from './types';
import { hasImage } from './types';

const QUIZ_DATA_URL = `${import.meta.env.BASE_URL}data/quiz_points.json`;

export class QuizDataError extends Error {}

let cache: QuizData | null = null;

/** quiz_points.json を読む。初回ロード後はメモリにキャッシュする。 */
export async function loadQuizData(): Promise<QuizData> {
  if (cache) return cache;
  let res: Response;
  try {
    res = await fetch(QUIZ_DATA_URL);
  } catch {
    throw new QuizDataError('出題データを取得できませんでした。通信状況を確認してください。');
  }
  if (!res.ok) {
    throw new QuizDataError(
      '出題データ（quiz_points.json）がまだありません。pipeline/ で生成してください。',
    );
  }
  const data = (await res.json()) as QuizData;
  if (!data.points || data.points.length === 0) {
    throw new QuizDataError('出題データに地点が1件もありません。');
  }
  cache = data;
  return data;
}

/** テストや再読込のためにキャッシュを捨てる。 */
export function resetQuizDataCache(): void {
  cache = null;
}

/** 画像パスを配信URLに変換する。 */
export function imageUrl(point: QuizPoint): string | null {
  return hasImage(point) ? `${import.meta.env.BASE_URL}${point.image_path}` : null;
}

/**
 * そのビューで出題できる地点だけを返す。
 * 画像を持たない地点はモード②（3D地形）専用（docs/spec.md 設計判断表）。
 */
export function playablePoints(
  data: QuizData,
  viewMode: 'map2d' | 'terrain3d',
): QuizPoint[] {
  return viewMode === 'map2d' ? data.points.filter(hasImage) : [...data.points];
}

export function findMountain(data: QuizData, mountainId: string): Mountain | null {
  return data.mountains.find((m) => m.id === mountainId) ?? null;
}

/** その地点が属する山。見つからない場合に備えて既定値を返す。 */
export function mountainOf(data: QuizData, point: QuizPoint): Mountain {
  return (
    findMountain(data, point.mountain_id) ?? {
      id: point.mountain_id,
      name: '不明な山',
      max_distance_m: 1000,
      scoring_k: 4,
    }
  );
}

/** モード②の初期カメラ方位。カメラ方位が無ければ進行方位で代用する。 */
export function initialHeading(point: QuizPoint): number {
  return point.heading_deg ?? point.heading_route_deg ?? 0;
}

export interface MapView {
  center: { lat: number; lon: number };
  zoom: number;
}

/**
 * 出題開始時の地図の初期表示。
 *
 * **正解地点を中心にしてはいけない**（画面中央がそのまま答えになる）。
 * その山の全地点を含む範囲の中心を、山ごとに固定の見え方で表示する。
 * こうすると、どの問題も同じ画から始まるので位置の手がかりが漏れない。
 */
export function mountainView(data: QuizData, mountainId: string): MapView {
  const points = data.points.filter((p) => p.mountain_id === mountainId);
  if (points.length === 0) {
    return { center: { lat: 35.36, lon: 138.73 }, zoom: 9 };
  }
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };

  // 範囲の広さからズームを決める。地点が1つしかない山では広く引いて、
  // 中心＝正解であることが手がかりにならないようにする。
  const spanDeg = Math.max(maxLat - minLat, (maxLon - minLon) * 0.82);
  if (spanDeg <= 0.0005) return { center, zoom: 10 };
  // 経験則: 緯度 0.045度（約5km）で zoom 12 くらい
  const zoom = Math.log2(0.045 / spanDeg) + 12;
  return { center, zoom: Math.max(9.5, Math.min(13, zoom)) };
}
