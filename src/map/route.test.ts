import { describe, expect, it } from 'vitest';
import { RoutePath, angleDiffDeg, newGroundInterval } from './route';
import { distanceMeters } from '../scoring';
import type { TrackFeature } from '../types';

const M_PER_DEG_LAT = 111_320;
const LAT0 = 34.18;
const LON0 = 136.1;
const mPerLon = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** 真北にまっすぐ伸びる長さ lengthM のトラック。 */
function straightTrack(lengthM: number, step = 10): TrackFeature {
  const coords: [number, number][] = [];
  for (let d = 0; d <= lengthM; d += step) coords.push([LON0, LAT0 + d / M_PER_DEG_LAT]);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  };
}

/** 北に100m進んでから東に100m進むL字のトラック。 */
function bentTrack(): TrackFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [LON0, LAT0],
        [LON0, LAT0 + 100 / M_PER_DEG_LAT],
        [LON0 + 100 / mPerLon, LAT0 + 100 / M_PER_DEG_LAT],
      ],
    },
  };
}

describe('angleDiffDeg', () => {
  it('北をまたいでも最短の差を返す', () => {
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20, 6);
    expect(angleDiffDeg(350, 10)).toBeCloseTo(-20, 6);
    expect(angleDiffDeg(90, 90)).toBeCloseTo(0, 6);
  });
});

describe('RoutePath', () => {
  it('点が2つ未満のトラックからは作れない', () => {
    expect(RoutePath.from(null)).toBeNull();
    expect(
      RoutePath.from({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[LON0, LAT0]] },
      }),
    ).toBeNull();
  });

  it('全長を距離で返す', () => {
    const route = RoutePath.from(straightTrack(500))!;
    expect(route.totalM).toBeCloseTo(500, 0);
  });

  it('累積距離から座標を引ける', () => {
    const route = RoutePath.from(straightTrack(500))!;
    const p = route.positionAt(250);
    expect(distanceMeters({ lat: LAT0, lon: LON0 }, p)).toBeCloseTo(250, 0);
  });

  it('範囲外の距離は端に丸める', () => {
    const route = RoutePath.from(straightTrack(200))!;
    expect(route.positionAt(-50).lat).toBeCloseTo(LAT0, 6);
    expect(route.positionAt(9999).lat).toBeCloseTo(LAT0 + 200 / M_PER_DEG_LAT, 6);
  });

  it('進行方位を返す（北なら0度、東なら90度）', () => {
    const straight = RoutePath.from(straightTrack(500))!;
    expect(straight.bearingAt(250)).toBeCloseTo(0, 1);

    const bent = RoutePath.from(bentTrack())!;
    expect(bent.bearingAt(20)).toBeCloseTo(0, 1);
    expect(bent.bearingAt(180)).toBeCloseTo(90, 1);
  });

  it('曲がり角では前後の弦の向きになる（細かい蛇行を拾わない）', () => {
    const bent = RoutePath.from(bentTrack())!;
    expect(bent.bearingAt(100, 40)).toBeCloseTo(45, 1);
  });

  it('近い点をトラック上の距離に落とす', () => {
    const route = RoutePath.from(straightTrack(500))!;
    // ルートから30m東に外れた点
    const off = { lat: LAT0 + 250 / M_PER_DEG_LAT, lon: LON0 + 30 / mPerLon };
    const anchor = route.anchorFor(off);
    expect(anchor.alongM).toBeCloseTo(250, 0);
    expect(anchor.offsetM).toBeCloseTo(30, 0);
  });

  it('トラックの外側の点は端に寄る', () => {
    const route = RoutePath.from(straightTrack(200))!;
    const beyond = { lat: LAT0 + 400 / M_PER_DEG_LAT, lon: LON0 };
    const anchor = route.anchorFor(beyond);
    expect(anchor.alongM).toBeCloseTo(200, 0);
    expect(anchor.offsetM).toBeCloseTo(200, 0);
  });

  it('頂点が多くても正しい線分を選ぶ（二分探索の境界）', () => {
    const route = RoutePath.from(straightTrack(1000, 1))!;
    for (const along of [0, 1, 499.5, 999, 1000]) {
      const p = route.positionAt(along);
      // 局所平面での計算なので大円距離とは0.1%ほどずれる（歩幅には十分）
      const actual = distanceMeters({ lat: LAT0, lon: LON0 }, p);
      expect(Math.abs(actual - along)).toBeLessThan(0.5 + along * 0.002);
    }
  });
});

describe('newGroundInterval（時間を取る区間）', () => {
  it('先へ進んだぶんだけ数える', () => {
    expect(newGroundInterval(100, 180, 100)).toEqual({ from: 100, to: 180 });
  });

  it('出題地点より手前に戻るのは無料（もう歩いてきた道）', () => {
    expect(newGroundInterval(100, 20, 100)).toBeNull();
    expect(newGroundInterval(20, 60, 100)).toBeNull();
  });

  it('一度行った先へ戻るのも無料（さっき見た道）', () => {
    expect(newGroundInterval(180, 120, 180)).toBeNull();
    // そこからさらに先へ出た区間だけ数える
    expect(newGroundInterval(120, 200, 180)).toEqual({ from: 180, to: 200 });
  });

  it('同じ場所なら区間なし', () => {
    expect(newGroundInterval(100, 100, 100)).toBeNull();
  });
});
