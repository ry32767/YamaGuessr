/**
 * モード②の3D地形ビュー（機能G）。
 *
 * **その地点に立って見回す一人称視点**にする。上空から地点を眺める形だと、
 * 「自分がどこに立っているか」が伝わらないため。ストリートビューと同じで、
 * ドラッグすると視線だけが回り、立ち位置は動かない。
 *
 * **地形図タイルを地形テクスチャに使わない。** 山名・三角点・注記が焼き込まれており、
 * 答えが画面に表示されてしまう（docs/spec.md 設計判断表）。描くのは陰影起伏だけ。
 */
import maplibregl, { LngLat, Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../scoring';
import {
  GSI_ATTRIBUTION,
  TERRAIN_EXAGGERATION,
  TERRAIN_SOURCE,
  registerGsiDemProtocol,
  terrainStyle,
} from './style';

/** 目の高さ [m]。地面にめり込まないよう地形標高に足す */
const EYE_HEIGHT_M = 1.6;
/**
 * 視線の角度 [deg]。MapLibre の pitch と同じ定義で、0 = 真下、90 = 水平。
 * MapLibre の上限が 85 度なので、真横より少しだけ下向きが上限になる。
 */
const MIN_PITCH = 40;
const MAX_PITCH = 85;
/** 視線の先に置く仮想的な注視点までの水平距離 [m] */
const LOOK_DISTANCE_M = 2000;
/** ドラッグ量に対する回転の感度 */
const YAW_PER_PX = 0.22;
const PITCH_PER_PX = 0.18;
/** 標高が取れるまでの再試行 */
const ELEVATION_RETRY_MS = 250;
const ELEVATION_MAX_TRIES = 20;

const SOURCE_HERE = 'yg-here';
const LAYER_HERE = 'yg-here-circle';
const LAYER_HERE_RING = 'yg-here-ring';

export interface Terrain3DOptions {
  center: LatLng;
  /** 初期の視線方位（真北基準・時計回り） */
  headingDeg: number;
  /**
   * 立っている地面の標高 [m]。出題データ（地理院DEM由来）から渡す。
   * 省略すると地図の地形から拾うが、タイルが届くまで正しい値にならない。
   */
  groundElevationM?: number | undefined;
}

/** 指定方位・距離だけ離れた座標。視線の先の注視点を作るのに使う。 */
function offsetLngLat(origin: LatLng, bearingDeg: number, distanceM: number): LngLat {
  const rad = (bearingDeg * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((origin.lat * Math.PI) / 180);
  return new LngLat(
    origin.lon + (distanceM * Math.sin(rad)) / mPerDegLon,
    origin.lat + (distanceM * Math.cos(rad)) / mPerDegLat,
  );
}

/** 方位を「北」「北東」…の日本語表記にする。色だけ・数字だけに頼らないため。 */
export function compassLabel(bearingDeg: number): string {
  const names = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const index = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return names[index] ?? '北';
}

export class Terrain3D {
  readonly map: MapLibreMap;
  private center: LatLng;
  private bearing: number;
  private pitch = MAX_PITCH;
  private groundElevation = 0;
  private ready = false;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly hud: HTMLElement;
  private elevationTimer: number | null = null;

  constructor(container: HTMLElement, options: Terrain3DOptions) {
    registerGsiDemProtocol();
    this.center = options.center;
    this.bearing = options.headingDeg;
    this.groundElevation = options.groundElevationM ?? 0;

    this.map = new MapLibreMap({
      container,
      style: terrainStyle(),
      center: [options.center.lon, options.center.lat],
      zoom: 14,
      pitch: MAX_PITCH,
      bearing: options.headingDeg,
      maxPitch: MAX_PITCH,
      attributionControl: false,
      // 視線だけを動かすので、地図としての操作は全部切る
      dragPan: false,
      dragRotate: false,
      scrollZoom: false,
      boxZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      touchZoomRotate: false,
      touchPitch: false,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: GSI_ATTRIBUTION }),
      'bottom-right',
    );

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      'この地点に立ったときの3D地形。ドラッグまたは矢印キーで360度見回せます。地名は表示されません。',
    );
    canvas.style.cursor = 'grab';

    this.hud = document.createElement('div');
    this.hud.className = 'terrain-hud';
    container.appendChild(this.hud);

    if (import.meta.env.DEV) {
      // 開発時だけ、カメラの状態をコンソールから確かめられるようにする
      (window as unknown as { __terrain?: Terrain3D }).__terrain = this;
    }

    this.bindLookAround(canvas);
    this.map.on('load', () => {
      // 地形はスタイル読み込みが終わってから入れる。
      // 途中でカメラを動かすと地形が有効にならないことがあった。
      this.map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      this.ready = true;
      this.addHereMarker();
      if (this.groundElevation === 0) this.scheduleElevation();
      this.apply();
    });
    this.renderHud();
  }

  // -------------------------------------------------------------------------
  // 視点
  // -------------------------------------------------------------------------
  /**
   * カメラを出題地点の目の高さに置き、向きだけを反映する。
   *
   * MapLibre は「カメラ位置を直接指定する」APIを持たないので、
   * `calculateCameraOptionsFromTo` に「立っている場所」と「視線の先」を渡して
   * 逆算させる。これで center が動いても立ち位置は地点に固定される。
   */
  private apply(): void {
    this.renderHud();
    if (!this.ready) return;
    const eye = this.groundElevation + EYE_HEIGHT_M;
    const from = new LngLat(this.center.lon, this.center.lat);
    const to = offsetLngLat(this.center, this.bearing, LOOK_DISTANCE_M);
    // pitch 90 が水平。そこから下を向くほど注視点が下がる
    const drop = LOOK_DISTANCE_M / Math.tan((this.pitch * Math.PI) / 180);
    const options = this.map.calculateCameraOptionsFromTo(from, eye, to, eye - drop);
    this.map.jumpTo(options);
  }

  private look(deltaYaw: number, deltaPitch: number): void {
    this.bearing = (((this.bearing + deltaYaw) % 360) + 360) % 360;
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + deltaPitch));
    this.apply();
  }

  private bindLookAround(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragPointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragPointerId !== e.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // 右にドラッグすると視線が左に振れる＝景色が右へ流れる（ストリートビューと同じ）
      this.look(-dx * YAW_PER_PX, -dy * PITCH_PER_PX);
    });
    const end = (e: PointerEvent): void => {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragPointerId = null;
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // ポインタが使えなくても見回せるようにする
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft') this.look(-step, 0);
      else if (e.key === 'ArrowRight') this.look(step, 0);
      else if (e.key === 'ArrowUp') this.look(0, step);
      else if (e.key === 'ArrowDown') this.look(0, -step);
      else return;
      e.preventDefault();
    });
  }

  // -------------------------------------------------------------------------
  // 立ち位置の表示
  // -------------------------------------------------------------------------
  /** 足元に現在地の印を描く。見下ろすと自分が立っている場所が分かる。 */
  private addHereMarker(): void {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [this.center.lon, this.center.lat] },
    };
    if (this.map.getSource(SOURCE_HERE)) {
      const source = this.map.getSource(SOURCE_HERE);
      if (source && 'setData' in source) {
        (source as maplibregl.GeoJSONSource).setData(feature);
      }
      return;
    }
    this.map.addSource(SOURCE_HERE, { type: 'geojson', data: feature });
    this.map.addLayer({
      id: LAYER_HERE_RING,
      type: 'circle',
      source: SOURCE_HERE,
      paint: {
        'circle-radius': 22,
        'circle-color': '#e8a33d',
        'circle-opacity': 0.22,
        'circle-pitch-alignment': 'map',
      },
    });
    this.map.addLayer({
      id: LAYER_HERE,
      type: 'circle',
      source: SOURCE_HERE,
      paint: {
        'circle-radius': 7,
        'circle-color': '#e8a33d',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'map',
      },
    });
  }

  /**
   * 地形の標高が読めるまで待って、カメラの高さを合わせる。
   * タイルが届く前は 0m なので、地面に埋まった絵になってしまう。
   */
  private scheduleElevation(tries = 0): void {
    const elevation = this.map.queryTerrainElevation([this.center.lon, this.center.lat]);
    if (elevation !== null && elevation !== undefined) {
      this.groundElevation = elevation;
      this.apply();
      return;
    }
    if (tries >= ELEVATION_MAX_TRIES) return;
    this.elevationTimer = window.setTimeout(
      () => this.scheduleElevation(tries + 1),
      ELEVATION_RETRY_MS,
    );
  }

  private renderHud(): void {
    const elevation = this.groundElevation > 0 ? `標高 ${Math.round(this.groundElevation)} m` : '';
    this.hud.innerHTML = `
      <span class="terrain-hud__here">ここに立っています</span>
      <span class="terrain-hud__facing num">${Math.round(this.bearing)}°</span>
      <span class="terrain-hud__dir">${compassLabel(this.bearing)}向き</span>
      ${elevation ? `<span class="terrain-hud__ele num">${elevation}</span>` : ''}
    `;
  }

  // -------------------------------------------------------------------------
  // 出し入れ
  // -------------------------------------------------------------------------
  /** 次の問題へ。立ち位置と初期方位を移す。 */
  moveTo(center: LatLng, headingDeg: number, groundElevationM?: number): void {
    this.center = center;
    this.bearing = headingDeg;
    this.pitch = MAX_PITCH;
    this.groundElevation = groundElevationM ?? 0;
    this.clearElevationTimer();
    if (this.ready) {
      this.addHereMarker();
      if (this.groundElevation === 0) this.scheduleElevation();
    }
    this.apply();
  }

  resize(): void {
    this.map.resize();
  }

  private clearElevationTimer(): void {
    if (this.elevationTimer !== null) {
      window.clearTimeout(this.elevationTimer);
      this.elevationTimer = null;
    }
  }

  destroy(): void {
    this.clearElevationTimer();
    this.hud.remove();
    this.map.remove();
  }
}
