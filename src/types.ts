/**
 * 出題データ（public/data/quiz_points.json）の型。
 * スキーマの正は docs/data-model.md。変更したら両方を同時に更新すること。
 */

/** 出題地点の種別 */
export type PointType =
  | 'bend'
  | 'ridge_view'
  | 'ridge_start'
  | 'peak'
  | 'col'
  | 'manual';

/** 地点の出所 */
export type PointSource = 'auto' | 'manual';

/** 山（1本のGPXトラックに対応する単位） */
export interface Mountain {
  readonly id: string;
  readonly name: string;
  /** これ以上離れると0点になる距離 [m] */
  readonly max_distance_m: number;
  /** スコア減衰の急峻さ係数（既定4） */
  readonly scoring_k: number;
  /**
   * 地形図に描くGPXトラック（GeoJSON Feature）のパス。public/ からの相対。
   * GPX無しで作った山では省略される。
   */
  readonly track_path?: string;
}

/** トラック（GeoJSON の LineString Feature） */
export interface TrackFeature {
  readonly type: 'Feature';
  readonly properties: Record<string, unknown>;
  readonly geometry: {
    readonly type: 'LineString';
    readonly coordinates: readonly (readonly [number, number])[];
  };
}

/** 出題地点 */
export interface QuizPoint {
  readonly id: string;
  readonly mountain_id: string;
  /** GPXルート上にスナップ済みの緯度（生GPSではない） */
  readonly lat: number;
  /** GPXルート上にスナップ済みの経度（生GPSではない） */
  readonly lon: number;
  /** 国土地理院DEM由来の標高 [m]。3Dビューの視点の高さに使う */
  readonly elevation_m?: number;
  readonly type: PointType;
  /**
   * public/ からの相対パス。**任意**。
   * 無い地点は画像を持たず、モード②（3D地形）専用として出題する。
   */
  readonly image_path?: string;
  /** 画像の出所メディア（分割動画・後から足した素材の識別） */
  readonly media_id?: string;
  /** 動画先頭からの切り出し秒。画像が無い地点では無し */
  readonly frame_time_s?: number;
  /** カメラ方位（真北基準・時計回り）。算出不能な場合は無し */
  readonly heading_deg?: number;
  /** GPXルートの進行方位。heading_deg が無いときの初期視点に使う */
  readonly heading_route_deg?: number;
  readonly source: PointSource;
}

/** その地点がモード①（画像＋地形図）で出題できるか */
export function hasImage(
  point: QuizPoint,
): point is QuizPoint & { image_path: string } {
  return typeof point.image_path === 'string' && point.image_path.length > 0;
}

/** quiz_points.json 全体 */
export interface QuizData {
  /** 生成日時ベースの文字列。進捗の互換性判定に使う */
  readonly dataset_version: string;
  readonly mountains: readonly Mountain[];
  readonly points: readonly QuizPoint[];
}

/** ゲームモード */
export type GameMode = 'challenge10' | 'complete_all';

/** 出題ビュー（地形図のみ／3D地形つき） */
export type ViewMode = 'map2d' | 'terrain3d';
