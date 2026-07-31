import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT_M,
  MAX_AIM_M,
  MAX_DOWN_DEG,
  MIN_AIM_M,
  MIN_DOWN_DEG,
  NEAR_PLANE_RATIO,
  aimDistanceM,
  aimTarget,
  destination,
  nearestGroundDepthM,
} from './eye';
import { distanceMeters, type LatLng } from '../scoring';

const EYE: LatLng = { lat: 34.18, lon: 136.1 };
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 標高を距離の関数で与える地形。`profile` は東西南北を問わず「目からの距離」で決まる */
function terrain(profile: (distanceM: number) => number): (p: LatLng) => number {
  return (p) => profile(distanceMeters(EYE, p));
}

/**
 * 目から狙い先を見たときの実際の見下ろし角 [deg]（正が下向き）。
 *
 * 距離は `distanceMeters`（大円距離）で測る。実装は局所平面で座標を作るので、
 * 両者には0.1%ほどの差があり、角度に直すと最大0.05度ずれる。比較はその精度で行う。
 */
function downOfAim(eyeAltitudeM: number, aim: { target: LatLng; altitudeM: number }): number {
  return toDeg(Math.atan2(eyeAltitudeM - aim.altitudeM, distanceMeters(EYE, aim.target)));
}

const TERRAINS: { name: string; profile: (d: number) => number }[] = [
  { name: '平ら', profile: () => 0 },
  { name: 'ゆるい下り', profile: (d) => -0.08 * d },
  { name: '急な下り', profile: (d) => -0.4 * d },
  { name: '上り', profile: (d) => 0.3 * d },
  { name: '崖の縁', profile: (d) => (d < 2 ? 0 : -300) },
  { name: '谷を挟む尾根', profile: (d) => (d < 30 ? 0 : d < 400 ? -200 : -150) },
];

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

describe('aimTarget（一人称カメラの狙い先）', () => {
  /**
   * いちばん大事な性質。**地形が何であれ、見下ろし角は操作した角度そのもの。**
   * ここが崩れると、首を横に振っただけで視線が上下し「頭ごと動いた」ように見える。
   */
  it('どんな地形でも見下ろし角は操作した角度のまま', () => {
    for (const { name, profile } of TERRAINS) {
      for (const downDeg of [-30, -10, 0, 8, 25]) {
        const options = {
          eye: EYE,
          eyeAltitudeM: EYE_HEIGHT_M,
          bearingDeg: 0,
          downDeg,
          elevationAt: terrain(profile),
        };
        expect(downOfAim(options.eyeAltitudeM, aimTarget(options)), `${name} / ${downDeg}度`)
          .toBeCloseTo(downDeg, 1);
      }
    }
  });

  it('見上げると狙い先が目より高くなる（v5でpitch>90が使えるため）', () => {
    const options = {
      eye: EYE,
      eyeAltitudeM: 1000,
      bearingDeg: 0,
      downDeg: -25,
      elevationAt: terrain(() => 900),
    };
    const aim = aimTarget(options);
    expect(aim.altitudeM).toBeGreaterThan(options.eyeAltitudeM);
    // 見上げた先に地面は要らない（空中の一点を中心にできる）
    expect(aim.altitudeM).toBeGreaterThan(terrain(() => 900)(aim.target));
  });

  it('可動範囲の外を指定しても丸められる', () => {
    const base = { eye: EYE, eyeAltitudeM: EYE_HEIGHT_M, bearingDeg: 0, elevationAt: terrain(() => 0) };
    expect(downOfAim(EYE_HEIGHT_M, aimTarget({ ...base, downDeg: -90 }))).toBeCloseTo(
      MIN_DOWN_DEG,
      1,
    );
    expect(downOfAim(EYE_HEIGHT_M, aimTarget({ ...base, downDeg: 90 }))).toBeCloseTo(
      MAX_DOWN_DEG,
      1,
    );
  });

  /**
   * 近クリップ面（狙い先までの距離の1/75）は、いちばん近く写る地面より手前に
   * 無ければならない。手前に無いと足元が切り取られ、その穴から地形の**裏側**が見える。
   */
  it('足元の地面が近クリップ面に切り取られない', () => {
    for (const { name, profile } of TERRAINS) {
      for (const downDeg of [-20, 0, 10, MAX_DOWN_DEG]) {
        const options = {
          eye: EYE,
          eyeAltitudeM: EYE_HEIGHT_M,
          bearingDeg: 0,
          downDeg,
          elevationAt: terrain(profile),
        };
        const nearPlaneM = aimTarget(options).distanceM * NEAR_PLANE_RATIO;
        expect(nearPlaneM, `${name} / ${downDeg}度`).toBeLessThan(nearestGroundDepthM(options));
      }
    }
  });

  it('狙い先までの距離は決めた範囲に収まる', () => {
    for (const { profile } of TERRAINS) {
      for (const downDeg of [-30, 0, 30]) {
        const distance = aimDistanceM({
          eye: EYE,
          eyeAltitudeM: EYE_HEIGHT_M,
          bearingDeg: 0,
          downDeg,
          elevationAt: terrain(profile),
        });
        expect(distance).toBeGreaterThanOrEqual(MIN_AIM_M);
        expect(distance).toBeLessThanOrEqual(MAX_AIM_M);
      }
    }
  });

  it('下を向くほど狙い先を近くに詰める（足元が近くなるため）', () => {
    const base = {
      eye: EYE,
      eyeAltitudeM: EYE_HEIGHT_M,
      bearingDeg: 0,
      elevationAt: terrain(() => 0),
    };
    expect(aimDistanceM({ ...base, downDeg: 30 })).toBeLessThan(
      aimDistanceM({ ...base, downDeg: 0 }),
    );
    // 見上げているときは足元に地面が写らないので、いちばん遠くまで狙える
    expect(aimDistanceM({ ...base, downDeg: -20 })).toBe(MAX_AIM_M);
  });

  it('狙い先の座標・標高・距離が整合している', () => {
    const options = {
      eye: EYE,
      eyeAltitudeM: 1000 + EYE_HEIGHT_M,
      bearingDeg: 30,
      downDeg: 8,
      elevationAt: terrain((d) => 1000 - 0.05 * d),
    };
    const aim = aimTarget(options);
    const horizontal = distanceMeters(EYE, aim.target);
    expect(aim.distanceM).toBeCloseTo(
      Math.hypot(horizontal, options.eyeAltitudeM - aim.altitudeM),
      0,
    );
  });
});
