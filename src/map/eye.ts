/**
 * 一人称カメラの狙い先（地図の中心に据える地面の1点）を決める。
 *
 * MapLibre のカメラは「地面の1点を見る」形しか取れず、`pitch` の上限が85度なので
 * 水平より上は見上げられない。また地形を有効にすると**中心の標高は必ず地面の標高**に
 * 合わせられるため、中心を空中に置くこともできない。
 *
 * そこで **視線を地形に当てた点** を中心にする。その点の標高は地形の標高そのものだから
 * 帳尻が合い、カメラはぴったり目の位置（地面＋目線の高さ）に立つ。副作用として
 * 「見ている先までの距離」でズームが決まるので、近くを見れば寄り、遠くを見れば引く。
 */
import type { LatLng } from '../scoring';

const M_PER_DEG_LAT = 111_320;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 目線の高さ [m]。ルート上の地面からこれだけ上にカメラを置く */
export const EYE_HEIGHT_M = 1.5;

/**
 * 見下ろし角の下限 [deg]（0が水平）。
 * MapLibre の pitch 上限85度がそのままこの値になる（pitch = 90 - 見下ろし角）。
 */
export const MIN_DOWN_DEG = 5.5;

/** 見下ろし角の上限 [deg]。足元を覗き込む程度まで。俯瞰はしない */
export const MAX_DOWN_DEG = 24;

/**
 * 地形の都合で視線を下げるときの限界 [deg]。
 *
 * 急斜面の先や標高タイルの読み込み途中では、地形に当たる角度が極端に下向きになりうる。
 * そのまま従うと真上から見下ろす画（俯瞰）になってしまうので、ここで必ず止める。
 * **一人称を崩さないための保険**（DESIGN.md 不変条件2b）。
 */
export const MAX_AIM_DOWN_DEG = 45;

/**
 * 視線を追う最遠距離 [m]。
 *
 * 狙い先が遠いほど地図のズームは下がり、近くの地形とテクスチャが粗くなる
 * （MapLibreはズームから描くタイルの細かさを決めるため）。**ズーム14を切ると
 * 標高タイルが1段粗いものに替わり、MapLibre側の「カメラが地形に潜ったか」の判定と
 * こちらの標高の読みがずれて、視点を書き換えられる。** その手前で止める。
 */
export const MAX_RANGE_M = 1200;

const MIN_RANGE_M = 2;
/** 距離のサンプル間隔（等比）。細かすぎても粗すぎても当たり判定が鈍る */
const SAMPLE_RATIO = 1.2;

export interface Aim {
  /** 地図の中心に据える点 */
  target: LatLng;
  /** その点の標高 [m]（地形の誇張後の値） */
  targetAltitudeM: number;
  /** 目からその点までの距離 [m] */
  distanceM: number;
  /** 実際の見下ろし角 [deg] */
  downDeg: number;
}

export interface AimOptions {
  eye: LatLng;
  /** 目の高さの標高 [m]（地形の誇張後の値） */
  eyeAltitudeM: number;
  bearingDeg: number;
  /** 見下ろしたい角度 [deg]。地形の見え方によっては下向きに補正される */
  downDeg: number;
  /** 座標の標高 [m]（地形の誇張後の値）を返す */
  elevationAt: (p: LatLng) => number;
}

/**
 * 視線が地面に届かない向きで、**いちばん水平に近く見られる**距離を選ぶ。
 *
 * MapLibreは「地面の1点」しか画面中心にできないので、谷を見渡す向きのように
 * 視線の先に地面が無いときは、地形の際（掠める角度が最小の場所）を狙うしかない。
 * ここで一番浅い角度を選んでおけば、操作した角度からのずれが最小になる。
 */
function flattestDistance(distances: number[], grazes: number[]): number {
  let best = distances[distances.length - 1] as number;
  let smallest = Infinity;
  for (let i = 0; i < distances.length; i += 1) {
    const g = grazes[i] ?? Infinity;
    if (g < smallest) {
      smallest = g;
      best = distances[i] as number;
    }
  }
  return best;
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
 * 視線が地形に当たる点を求める。
 *
 * 当たらない（＝空を見ている）向きでは、その方位の**地形の際（きわ）**まで視線を下げる。
 * 上限85度の pitch では水平線より上を中心にできないので、見下ろし角を下げるしかない。
 */
export function aimAtTerrain(options: AimOptions): Aim {
  const { eye, eyeAltitudeM, bearingDeg, elevationAt } = options;

  const distances: number[] = [];
  for (let t = MIN_RANGE_M; t < MAX_RANGE_M; t *= SAMPLE_RATIO) distances.push(t);
  distances.push(MAX_RANGE_M);

  const at = (t: number): number => elevationAt(destination(eye, bearingDeg, t));
  /** 距離 t の地面をちょうど掠める見下ろし角 */
  const grazing = (t: number): number => toDeg(Math.atan2(eyeAltitudeM - at(t), t));

  const grazes = distances.map(grazing);
  // **見下ろし角は操作した角度そのまま。地形で勝手に変えない。**
  // 変えると、首を横に振っただけで視線が上下し「頭ごと動いた」ように見える。
  const downDeg = Math.min(MAX_AIM_DOWN_DEG, Math.max(options.downDeg, MIN_DOWN_DEG));

  const tan = Math.tan(toRad(downDeg));
  /** 視線が地面より上なら正 */
  const gap = (t: number): number => eyeAltitudeM - t * tan - at(t);

  // 視線が地面に入る場所のうち**一番遠いもの**を選ぶ。
  // 手前の交差を選ぶと極端に寄った画になり、遠くの尾根が描かれなくなる。
  // 手前の地形に隠れて見えない点でも、視線の向きは同じで画は変わらない
  // （中心をどこに置いても、目の位置と向きが同じなら見える景色は同じ）。
  let index = -1;
  for (let i = distances.length - 1; i >= 1; i -= 1) {
    if ((grazes[i] ?? Infinity) <= downDeg && (grazes[i - 1] ?? -Infinity) > downDeg) {
      index = i;
      break;
    }
  }
  // 目の前が壁（最初のサンプルから地面の中）のときは、手前の交差を使う
  if (index < 0) index = grazes.findIndex((g) => g <= downDeg);

  if (index >= 0) {
    let above = index > 0 ? (distances[index - 1] as number) : MIN_RANGE_M;
    let below = distances[index] as number;
    if (gap(above) <= 0) above = MIN_RANGE_M;
    for (let k = 0; k < 14; k += 1) {
      const mid = (above + below) / 2;
      if (gap(mid) > 0) above = mid;
      else below = mid;
    }
    const hit = (above + below) / 2;
    const found = aimAt(eye, bearingDeg, hit, eyeAltitudeM, elevationAt);
    if (found.downDeg <= MAX_AIM_DOWN_DEG + 1) return found;
  }

  // 視線の先に地面が無い（谷や海を見渡している）向き。
  // **一番浅く見られる場所**を狙う。狙い先の標高は実際の地形の値なので頭の位置は正しく、
  // 操作した角度からのずれも最小になる（これ以上水平に近づけるとどこにも当たらない）。
  const flattest = aimAt(
    eye,
    bearingDeg,
    flattestDistance(distances, grazes),
    eyeAltitudeM,
    elevationAt,
  );
  if (flattest.downDeg <= MAX_AIM_DOWN_DEG + 1) return flattest;

  // 崖の縁など、どこを狙っても真下に近い場合だけ、平らな地形と見なして角度を守る。
  // 頭の位置は多少ずれるが、俯瞰の画にはしない（DESIGN.md 不変条件2b）。
  const groundAtEye = elevationAt(eye);
  const drop = Math.max(0.5, eyeAltitudeM - groundAtEye);
  const hit = drop / tan;
  return {
    target: destination(eye, bearingDeg, hit),
    targetAltitudeM: groundAtEye,
    distanceM: Math.hypot(hit, drop),
    downDeg,
  };
}

/** ある距離の地面を狙ったときの視点。 */
function aimAt(
  eye: LatLng,
  bearingDeg: number,
  distance: number,
  eyeAltitudeM: number,
  elevationAt: (p: LatLng) => number,
): Aim {
  const target = destination(eye, bearingDeg, distance);
  const targetAltitudeM = elevationAt(target);
  return {
    target,
    targetAltitudeM,
    distanceM: Math.hypot(distance, eyeAltitudeM - targetAltitudeM),
    downDeg: toDeg(Math.atan2(eyeAltitudeM - targetAltitudeM, distance)),
  };
}
