/**
 * GPXトラックの上を歩くための計算。
 *
 * 3Dビューは「ルート上に立って見回す」一人称なので、現在地は
 * **トラック起点からの累積距離 [m]** ひとつで表せる。前後に歩く・近い場所へ飛ぶ・
 * 進行方位を知る、の3つができればよい。
 *
 * 距離は局所平面（等距円筒）で計算する。1本のトラックは長くても数十kmなので、
 * 歩幅の計算には十分な精度が出る（誤差は0.1%以下）。
 */
import type { LatLng } from '../scoring';
import type { TrackFeature } from '../types';

const M_PER_DEG_LAT = 111_320;

/** トラック上の位置。`offsetM` は問い合わせた点からトラックまでの距離 */
export interface RouteAnchor {
  alongM: number;
  offsetM: number;
}

/** 角度差を -180〜180 に正規化する。 */
export function angleDiffDeg(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

export class RoutePath {
  /** 頂点の平面座標 [m]（トラック先頭を原点とする） */
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  /** 各頂点までの累積距離 [m] */
  private readonly cum: number[] = [];
  private readonly originLat: number;
  private readonly originLon: number;
  private readonly mPerLon: number;

  private constructor(coords: readonly (readonly [number, number])[]) {
    const first = coords[0] as readonly [number, number];
    this.originLon = first[0];
    this.originLat = first[1];
    this.mPerLon = M_PER_DEG_LAT * Math.cos((this.originLat * Math.PI) / 180);
    for (const [lon, lat] of coords) {
      this.xs.push((lon - this.originLon) * this.mPerLon);
      this.ys.push((lat - this.originLat) * M_PER_DEG_LAT);
    }
    this.cum.push(0);
    for (let i = 1; i < this.xs.length; i += 1) {
      const dx = (this.xs[i] ?? 0) - (this.xs[i - 1] ?? 0);
      const dy = (this.ys[i] ?? 0) - (this.ys[i - 1] ?? 0);
      this.cum.push((this.cum[i - 1] ?? 0) + Math.hypot(dx, dy));
    }
  }

  /** 点が2つ以上あるトラックからだけ作れる。それ以外は null（＝歩けない）。 */
  static from(track: TrackFeature | null | undefined): RoutePath | null {
    const coords = track?.geometry.coordinates;
    if (!coords || coords.length < 2) return null;
    return new RoutePath(coords);
  }

  /** トラック全長 [m] */
  get totalM(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** 起点から `alongM` の位置の座標。範囲外は端に丸める。 */
  positionAt(alongM: number): LatLng {
    const target = Math.max(0, Math.min(this.totalM, alongM));
    const i = this.segmentIndex(target);
    const start = this.cum[i] ?? 0;
    const end = this.cum[i + 1] ?? start;
    const span = end - start;
    const t = span === 0 ? 0 : (target - start) / span;
    const x = (this.xs[i] ?? 0) + t * ((this.xs[i + 1] ?? 0) - (this.xs[i] ?? 0));
    const y = (this.ys[i] ?? 0) + t * ((this.ys[i + 1] ?? 0) - (this.ys[i] ?? 0));
    return this.toLatLng(x, y);
  }

  /**
   * その位置での進行方位 [deg]（真北基準・時計回り）。
   * 1本の線分だけを見ると細かい蛇行を拾うので、前後 `spanM` の弦で求める。
   */
  bearingAt(alongM: number, spanM = 20): number {
    const half = spanM / 2;
    const a = this.planeAt(Math.max(0, alongM - half));
    const b = this.planeAt(Math.min(this.totalM, alongM + half));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return 0;
    return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
  }

  /** 点に最も近いトラック上の位置。 */
  anchorFor(p: LatLng): RouteAnchor {
    const px = (p.lon - this.originLon) * this.mPerLon;
    const py = (p.lat - this.originLat) * M_PER_DEG_LAT;
    let bestOffset = Infinity;
    let bestAlong = 0;
    for (let i = 0; i < this.xs.length - 1; i += 1) {
      const ax = this.xs[i] ?? 0;
      const ay = this.ys[i] ?? 0;
      const bx = this.xs[i + 1] ?? 0;
      const by = this.ys[i + 1] ?? 0;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const offset = Math.hypot(px - cx, py - cy);
      if (offset < bestOffset) {
        bestOffset = offset;
        bestAlong = (this.cum[i] ?? 0) + Math.hypot(cx - ax, cy - ay);
      }
    }
    return { alongM: bestAlong, offsetM: bestOffset };
  }

  private planeAt(alongM: number): { x: number; y: number } {
    const target = Math.max(0, Math.min(this.totalM, alongM));
    const i = this.segmentIndex(target);
    const start = this.cum[i] ?? 0;
    const end = this.cum[i + 1] ?? start;
    const span = end - start;
    const t = span === 0 ? 0 : (target - start) / span;
    return {
      x: (this.xs[i] ?? 0) + t * ((this.xs[i + 1] ?? 0) - (this.xs[i] ?? 0)),
      y: (this.ys[i] ?? 0) + t * ((this.ys[i + 1] ?? 0) - (this.ys[i] ?? 0)),
    };
  }

  /** `alongM` を含む線分の番号。 */
  private segmentIndex(alongM: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cum[mid] ?? 0) <= alongM) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, this.xs.length - 2);
  }

  private toLatLng(x: number, y: number): LatLng {
    return {
      lat: this.originLat + y / M_PER_DEG_LAT,
      lon: this.originLon + x / this.mPerLon,
    };
  }
}
