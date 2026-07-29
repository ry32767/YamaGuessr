/**
 * GPXトラックの切り出し。
 *
 * 3Dビューには**出題地点のすぐ足元のぶんだけ**を描く。ルート全体を出すと
 * どこを歩いているかが一目で分かってしまうため、進む向きが読める最小限に絞る。
 */
import type { LatLng } from '../scoring';
import type { TrackFeature } from '../types';

/** 3Dビューに描くルートの半径 [m]（この距離ぶん前後を描く） */
export const LOCAL_ROUTE_RADIUS_M = 10;

const M_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

interface Projected {
  x: number;
  y: number;
}

/** 線分上で点に最も近い位置を、0〜1のパラメータで返す。 */
function closestT(a: Projected, b: Projected, p: Projected): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
}

/**
 * トラックのうち、`center` から経路上で `radiusM` 以内の部分だけを取り出す。
 *
 * 途中で切れた端は線分を補間して、ちょうど半径のところで止める。
 * 対象が無ければ null（＝描かない）。
 */
export function localRouteSegment(
  track: TrackFeature,
  center: LatLng,
  radiusM: number = LOCAL_ROUTE_RADIUS_M,
): TrackFeature | null {
  const coords = track.geometry.coordinates;
  if (coords.length < 2) return null;

  const mPerLon = metersPerDegLon(center.lat);
  const project = (lon: number, lat: number): Projected => ({
    x: (lon - center.lon) * mPerLon,
    y: (lat - center.lat) * M_PER_DEG_LAT,
  });
  const origin: Projected = { x: 0, y: 0 };

  // 各頂点までの累積距離と、地点に最も近い経路位置を求める
  const points = coords.map(([lon, lat]) => project(lon, lat));
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) break;
    cumulative.push((cumulative[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }

  let bestDist = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const base = cumulative[i];
    if (!a || !b || base === undefined) continue;
    const t = closestT(a, b, origin);
    const cx = a.x + t * (b.x - a.x);
    const cy = a.y + t * (b.y - a.y);
    const d = Math.hypot(cx, cy);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = base + Math.hypot(cx - a.x, cy - a.y);
    }
  }

  const from = bestAlong - radiusM;
  const to = bestAlong + radiusM;
  const out: [number, number][] = [];

  const pointAt = (along: number): [number, number] | null => {
    const total = cumulative[cumulative.length - 1] ?? 0;
    const clamped = Math.max(0, Math.min(total, along));
    for (let i = 0; i < cumulative.length - 1; i += 1) {
      const start = cumulative[i];
      const end = cumulative[i + 1];
      if (start === undefined || end === undefined) continue;
      if (clamped > end) continue;
      const span = end - start;
      const t = span === 0 ? 0 : (clamped - start) / span;
      const a = coords[i];
      const b = coords[i + 1];
      if (!a || !b) return null;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    const last = coords[coords.length - 1];
    return last ? [last[0], last[1]] : null;
  };

  const start = pointAt(from);
  if (start) out.push(start);
  for (let i = 0; i < coords.length; i += 1) {
    const along = cumulative[i];
    const coord = coords[i];
    if (along === undefined || !coord) continue;
    if (along > from && along < to) out.push([coord[0], coord[1]]);
  }
  const end = pointAt(to);
  if (end) out.push(end);

  if (out.length < 2) return null;
  return {
    type: 'Feature',
    properties: { local: true },
    geometry: { type: 'LineString', coordinates: out },
  };
}
