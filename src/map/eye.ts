/**
 * 一人称カメラの狙い先（画面の中心に据える点）を決める。
 *
 * **MapLibre v5 の `centerClampedToGround: false` を使う。** 中心を地面に貼り付ける
 * 制約が外れるので、**視線上の一点をそのまま中心にできる**。おかげで
 *
 * - 見下ろし角は操作した角度そのもの（地形で勝手に変わらない）
 * - 水平も、見上げも表せる（`pitch > 90` が使えるため）
 * - ズームは狙い先までの距離だけで決まる（＝距離を一定にすれば画も落ち着く）
 *
 * となり、v4でやっていた「視線が地面に当たる点を探す」処理は要らなくなった。
 * 残る仕事は**狙い先をどれだけ先に置くか**だけで、これは近クリップ面が
 * 足元の地面を切り取らない距離、という条件で決まる（下記 `NEAR_PLANE_RATIO`）。
 */
import type { LatLng } from '../scoring';

const M_PER_DEG_LAT = 111_320;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** 目線の高さ [m]。ルート上の地面からこれだけ上にカメラを置く */
export const EYE_HEIGHT_M = 1.5;

/**
 * 見下ろし角の範囲 [deg]（0が水平、負が見上げ）。
 *
 * MapLibre の `pitch` は `90 - この角度`。v5 は pitch の上限が180まで開いたので、
 * **水平（pitch 90）も見上げ（pitch > 90）も表せる**。v4では85が上限で、
 * 視線の中心は必ず水平より5.5度下だった。
 */
export const MIN_DOWN_DEG = -40;
export const MAX_DOWN_DEG = 40;
/** 立ったときの既定の視線。山を見るのだから水平から始める */
export const DEFAULT_DOWN_DEG = 0;

/**
 * 一人称の画角（縦）[deg]。画面の下端は視線より半分だけ下を向く。
 *
 * MapLibre の既定は36.87度で、望遠レンズのように狭い。人の視野に近い**52度**まで
 * 開いて、周りの尾根が視界に入るようにしている（`map.setVerticalFieldOfView`）。
 * 広げるほど近クリップ面は相対的に遠くなり（下記）、足元も近く写るので、
 * **狙い先の距離はそのぶん詰まる**（`aimDistanceM` が自動で吸収する）。
 */
export const FOV_DEG = 52;

/**
 * 近クリップ面の位置。**画面中心（＝狙い先）までの距離のこの割合**の所に来る。
 *
 * MapLibre の Transform は `nearZ = 画面高さ / 50`[px]、画面中心までの距離
 * `= 0.5 / tan(画角/2) × 画面高さ`[px] を使うので、比は
 * `tan(画角/2) / 25` になる（画面サイズにもズームにも依らない。実距離[m]でも同じ）。
 *
 * **ここが一人称の見え方を決める。** 遠くを狙うほど近クリップ面も遠ざかり、
 * それより手前の地形——足元の地面——が描かれなくなる。**地形は裏面を捨てずに
 * 描かれる**ので、切り取られた穴からは向こう側の斜面の**裏側**が見えてしまう。
 */
export const NEAR_PLANE_RATIO = Math.tan(toRad(FOV_DEG / 2)) / 25;

/** 近クリップ面を、いちばん近い地面までの奥行きの何割までに収めるか */
const NEAR_PLANE_MARGIN = 0.8;

/** 狙い先までの距離の範囲 [m]。近すぎると寄りすぎ、遠すぎると足元が欠ける */
export const MIN_AIM_M = 40;
export const MAX_AIM_M = 250;

/** 地面を探すときの刻み（等比）と最短距離 */
const MIN_RANGE_M = 2;
const SAMPLE_RATIO = 1.2;

export interface AimOptions {
  eye: LatLng;
  /** 目の高さの標高 [m]（地形の誇張後の値） */
  eyeAltitudeM: number;
  bearingDeg: number;
  /** 見下ろしたい角度 [deg]。0が水平、負は見上げ */
  downDeg: number;
  /** 座標の標高 [m]（地形の誇張後の値）を返す */
  elevationAt: (p: LatLng) => number;
}

export interface Aim {
  /** 画面の中心に据える点（空中でよい） */
  target: LatLng;
  /** その点の標高 [m]（地形の誇張後の値） */
  altitudeM: number;
  /** 目からその点までの距離 [m]（斜距離） */
  distanceM: number;
}

/** ある方位・距離の座標。 */
export function destination(from: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const rad = toRad(bearingDeg);
  const mPerLon = M_PER_DEG_LAT * Math.cos(toRad(from.lat));
  return {
    lat: from.lat + (distanceM * Math.cos(rad)) / M_PER_DEG_LAT,
    lon: from.lon + (distanceM * Math.sin(rad)) / (mPerLon || 1),
  };
}

/**
 * 画面にいちばん近く写る地面までの奥行き [m]。
 *
 * 画角の**下端**（視線より `FOV_DEG/2` 下）を追い、地面に入った所までの距離を
 * 視線方向の奥行きに直して返す。これより手前に近クリップ面があれば足元は描かれる。
 * 見上げているときのように地面に当たらない向きでは `MAX_AIM_M` 相当を返す
 * （＝足元が切れる心配が無いので、狙い先を遠くに置いてよい）。
 */
export function nearestGroundDepthM(options: AimOptions): number {
  const { eye, eyeAltitudeM, bearingDeg, elevationAt } = options;
  const downDeg = clampDown(options.downDeg);
  const tan = Math.tan(toRad(downDeg + FOV_DEG / 2));
  const forward = Math.cos(toRad(FOV_DEG / 2));
  const limit = MAX_AIM_M / NEAR_PLANE_MARGIN;
  if (tan <= 0) return limit;
  for (let t = MIN_RANGE_M; t <= limit; t *= SAMPLE_RATIO) {
    const drop = eyeAltitudeM - elevationAt(destination(eye, bearingDeg, t));
    if (drop <= t * tan) return Math.hypot(t, drop) * forward;
  }
  return limit;
}

/** 見下ろし角を可動範囲に収める。 */
export function clampDown(downDeg: number): number {
  return Math.max(MIN_DOWN_DEG, Math.min(MAX_DOWN_DEG, downDeg));
}

/**
 * 狙い先までの距離 [m]。
 *
 * **近クリップ面（狙い先までの距離の1/75）が、いちばん近く写る地面より手前に
 * 収まる距離までしか狙わない。** これを超えると足元が切り取られ、その穴から
 * 地形の裏側が見える。逆に、崖の縁や見上げのようにいちばん近い地面が遠い向きでは、
 * 遠くまで狙ってよい（穴が開きようがない）。
 */
export function aimDistanceM(options: AimOptions): number {
  const limit = (nearestGroundDepthM(options) * NEAR_PLANE_MARGIN) / NEAR_PLANE_RATIO;
  return Math.max(MIN_AIM_M, Math.min(MAX_AIM_M, limit));
}

/**
 * 画面の中心に据える点。**視線の上の一点**で、地面である必要はない。
 *
 * 中心の標高が視線と一致しているので、MapLibre がカメラをその視線上に置く。
 * 結果としてカメラは目の位置に、見下ろし角は操作した角度のままになる。
 */
export function aimTarget(options: AimOptions): Aim {
  const downDeg = clampDown(options.downDeg);
  const distanceM = aimDistanceM(options);
  const horizontalM = distanceM * Math.cos(toRad(downDeg));
  return {
    target: destination(options.eye, options.bearingDeg, horizontalM),
    altitudeM: options.eyeAltitudeM - distanceM * Math.sin(toRad(downDeg)),
    distanceM,
  };
}
