import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT_M,
  MAX_AIM_DOWN_DEG,
  MAX_RANGE_M,
  MIN_DOWN_DEG,
  aimAtTerrain,
  destination,
} from './eye';
import { distanceMeters, type LatLng } from '../scoring';

const EYE: LatLng = { lat: 34.18, lon: 136.1 };
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 標高を距離の関数で与える地形。`profile` は東西南北を問わず「目からの距離」で決まる */
function terrain(profile: (distanceM: number) => number): (p: LatLng) => number {
  return (p) => profile(distanceMeters(EYE, p));
}

/** 目から見た狙い先の見下ろし角 [deg]。 */
function downOf(eyeAltitude: number, targetAltitude: number, horizontalM: number): number {
  return toDeg(Math.atan2(eyeAltitude - targetAltitude, horizontalM));
}

describe('destination', () => {
  it('方位と距離ぶん離れた座標を返す', () => {
    const north = destination(EYE, 0, 100);
    expect(distanceMeters(EYE, north)).toBeCloseTo(100, 0);
    expect(north.lat).toBeGreaterThan(EYE.lat);
    expect(north.lon).toBeCloseTo(EYE.lon, 9);

    const east = destination(EYE, 90, 100);
    expect(distanceMeters(EYE, east)).toBeCloseTo(100, 0);
    expect(east.lon).toBeGreaterThan(EYE.lon);
    expect(east.lat).toBeCloseTo(EYE.lat, 9);
  });
});

describe('aimAtTerrain', () => {
  it('平らな地形では、下限の見下ろし角で目線の高さぶん先の地面を狙う', () => {
    const aim = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 0,
      downDeg: MIN_DOWN_DEG,
      elevationAt: terrain(() => 0),
    });
    // 1.5m の高さから 5.5度 見下ろすと、約 15.6m 先の地面に当たる
    const expected = EYE_HEIGHT_M / Math.tan((MIN_DOWN_DEG * Math.PI) / 180);
    expect(distanceMeters(EYE, aim.target)).toBeCloseTo(expected, 0);
    expect(aim.targetAltitudeM).toBe(0);
    expect(aim.downDeg).toBeCloseTo(MIN_DOWN_DEG, 1);
  });

  it('もっと下を向くと狙い先が近くなる', () => {
    const flat = terrain(() => 0);
    const near = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 0,
      downDeg: 20,
      elevationAt: flat,
    });
    expect(near.downDeg).toBeCloseTo(20, 1);
    expect(distanceMeters(EYE, near.target)).toBeLessThan(5);
  });

  it('上り斜面ではすぐ手前の地面に当たる', () => {
    // 45度で立ち上がる斜面
    const aim = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 90,
      downDeg: MIN_DOWN_DEG,
      elevationAt: terrain((d) => d),
    });
    expect(distanceMeters(EYE, aim.target)).toBeLessThan(3);
  });

  it('下り斜面では遠くの地面に当たる', () => {
    const aim = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 180,
      downDeg: MIN_DOWN_DEG,
      elevationAt: terrain((d) => -0.1 * d),
    });
    const horizontal = distanceMeters(EYE, aim.target);
    expect(horizontal).toBeGreaterThan(100);
    expect(horizontal).toBeLessThanOrEqual(MAX_RANGE_M);
    // 地面より下を狙わない（狙い先の標高は地形の標高そのもの）
    expect(aim.targetAltitudeM).toBeCloseTo(-0.1 * horizontal, 1);
  });

  it('見下ろし角は必ず下限以上になる（pitchが85度を超えないため）', () => {
    // ほぼ平ら＝水平線が遠い地形。水平に近い視線を要求しても下限までは下がる
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const aim = aimAtTerrain({
        eye: EYE,
        eyeAltitudeM: EYE_HEIGHT_M,
        bearingDeg: bearing,
        downDeg: 0,
        elevationAt: terrain(() => 0),
      });
      expect(aim.downDeg).toBeGreaterThanOrEqual(MIN_DOWN_DEG - 0.01);
      expect(90 - aim.downDeg).toBeLessThanOrEqual(85);
    }
  });

  it('崖の縁では地形の際まで視線が下がり、手前の地面を狙う', () => {
    // 50m 先から400m落ちる地形。水平に近い視線ではどこにも当たらないので、
    // 際（遠くの谷底を掠める角度）まで下げる。その結果、手前の平地に当たる
    const aim = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 0,
      downDeg: MIN_DOWN_DEG,
      elevationAt: terrain((d) => (d < 50 ? 0 : -400)),
    });
    expect(aim.downDeg).toBeGreaterThan(MIN_DOWN_DEG);
    expect(distanceMeters(EYE, aim.target)).toBeLessThan(50);
    expect(aim.targetAltitudeM).toBe(0);
  });

  it('どんな地形でも俯瞰にならない（見下ろし角に上限がある）', () => {
    // 目の前から垂直に落ちる地形。素直に地形へ視線を当てると真下を向いてしまう
    const cliff = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 0,
      downDeg: MIN_DOWN_DEG,
      elevationAt: terrain((d) => -1000 * d),
    });
    expect(cliff.downDeg).toBeLessThanOrEqual(MAX_AIM_DOWN_DEG + 1);
    // 標高が全く取れない（＝0が返り続ける）地形でも一人称のまま
    const unknown = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: 1000,
      bearingDeg: 0,
      downDeg: MIN_DOWN_DEG,
      elevationAt: () => 0,
    });
    expect(unknown.downDeg).toBeLessThanOrEqual(MAX_AIM_DOWN_DEG + 1);
    expect(unknown.downDeg).toBeGreaterThanOrEqual(MIN_DOWN_DEG - 0.01);
  });

  it('狙い先の標高と距離が整合している', () => {
    const aim = aimAtTerrain({
      eye: EYE,
      eyeAltitudeM: 1000 + EYE_HEIGHT_M,
      bearingDeg: 30,
      downDeg: 8,
      elevationAt: terrain((d) => 1000 - 0.05 * d),
    });
    const horizontal = distanceMeters(EYE, aim.target);
    expect(aim.distanceM).toBeCloseTo(
      Math.hypot(horizontal, 1000 + EYE_HEIGHT_M - aim.targetAltitudeM),
      0,
    );
    expect(aim.downDeg).toBeCloseTo(
      downOf(1000 + EYE_HEIGHT_M, aim.targetAltitudeM, horizontal),
      1,
    );
  });
});
