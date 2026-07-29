import { describe, expect, it } from 'vitest';
import { LOCAL_ROUTE_RADIUS_M, localRouteSegment } from './route';
import { distanceMeters } from '../scoring';
import type { TrackFeature } from '../types';

const M_PER_DEG_LAT = 111_320;

/** 真北にまっすぐ伸びる長さ lengthM のトラック。 */
function straightTrack(lengthM: number, step = 10): TrackFeature {
  const coords: [number, number][] = [];
  for (let d = 0; d <= lengthM; d += step) {
    coords.push([136.1, 34.18 + d / M_PER_DEG_LAT]);
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  };
}

function lengthOf(track: TrackFeature): number {
  const coords = track.geometry.coordinates;
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    total += distanceMeters({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
  }
  return total;
}

describe('localRouteSegment（3Dに描く足元のルート）', () => {
  it('地点の前後およそ10mだけを切り出す', () => {
    const track = straightTrack(500);
    const center = { lat: 34.18 + 250 / M_PER_DEG_LAT, lon: 136.1 };
    const segment = localRouteSegment(track, center)!;
    expect(segment).not.toBeNull();
    expect(lengthOf(segment)).toBeCloseTo(LOCAL_ROUTE_RADIUS_M * 2, 0);
  });

  it('半径を変えられる', () => {
    const track = straightTrack(500);
    const center = { lat: 34.18 + 250 / M_PER_DEG_LAT, lon: 136.1 };
    expect(lengthOf(localRouteSegment(track, center, 40)!)).toBeCloseTo(80, 0);
  });

  it('切り出した区間は地点のすぐそばを通る', () => {
    const track = straightTrack(500);
    const center = { lat: 34.18 + 250 / M_PER_DEG_LAT, lon: 136.1 };
    const segment = localRouteSegment(track, center)!;
    const nearest = Math.min(
      ...segment.geometry.coordinates.map((c) =>
        distanceMeters(center, { lat: c[1], lon: c[0] }),
      ),
    );
    expect(nearest).toBeLessThan(LOCAL_ROUTE_RADIUS_M + 1);
  });

  it('ルート全体は描かない（元より遥かに短い）', () => {
    const track = straightTrack(2000);
    const center = { lat: 34.18 + 1000 / M_PER_DEG_LAT, lon: 136.1 };
    const segment = localRouteSegment(track, center)!;
    expect(lengthOf(segment)).toBeLessThan(lengthOf(track) / 50);
  });

  it('端の地点でも破綻せず、はみ出さない', () => {
    const track = straightTrack(200);
    const start = localRouteSegment(track, { lat: 34.18, lon: 136.1 })!;
    expect(start).not.toBeNull();
    expect(lengthOf(start)).toBeGreaterThan(0);
    expect(lengthOf(start)).toBeLessThanOrEqual(LOCAL_ROUTE_RADIUS_M * 2 + 1);

    const end = localRouteSegment(track, {
      lat: 34.18 + 200 / M_PER_DEG_LAT,
      lon: 136.1,
    })!;
    expect(lengthOf(end)).toBeGreaterThan(0);
  });

  it('曲がったルートでも地点付近の形を保つ', () => {
    const track: TrackFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [136.1, 34.18],
          [136.1, 34.18 + 100 / M_PER_DEG_LAT],
          [136.1 + 100 / (M_PER_DEG_LAT * Math.cos((34.18 * Math.PI) / 180)),
            34.18 + 100 / M_PER_DEG_LAT],
        ],
      },
    };
    const corner = { lat: 34.18 + 100 / M_PER_DEG_LAT, lon: 136.1 };
    const segment = localRouteSegment(track, corner)!;
    // 曲がり角をまたぐので、頂点が1つは残る
    expect(segment.geometry.coordinates.length).toBeGreaterThanOrEqual(3);
    expect(lengthOf(segment)).toBeCloseTo(LOCAL_ROUTE_RADIUS_M * 2, 0);
  });

  it('点が2つ未満のトラックでは null', () => {
    const track: TrackFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[136.1, 34.18]] },
    };
    expect(localRouteSegment(track, { lat: 34.18, lon: 136.1 })).toBeNull();
  });
});
