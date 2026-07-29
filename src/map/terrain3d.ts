/**
 * モード②の3D地形ビュー（機能G）。
 *
 * **出題地点を軸に、向きだけを変える。** カメラは常に出題地点を注視しているので、
 * ドラッグしても立ち位置は1mmも動かない。真下を向けば自分がいる地点が画面の
 * 真ん中に見える。上空から地点を眺める形だと「自分がどこに立っているか」が
 * 伝わらないため、既定はほぼ水平の見回しにしてある。
 *
 * **地形図タイルを地形テクスチャに使わない。** 山名・三角点・注記が焼き込まれており、
 * 答えが画面に表示されてしまう（docs/spec.md 設計判断表）。描くのは陰影起伏だけ。
 */
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../scoring';
import type { TrackFeature } from '../types';
import { LOCAL_ROUTE_RADIUS_M, localRouteSegment } from './route';
import {
  GSI_ATTRIBUTION,
  TERRAIN_EXAGGERATION,
  TERRAIN_SOURCE,
  registerGsiDemProtocol,
  terrainStyle,
} from './style';

/** 視点モード */
export type ViewPreset = 'first_person' | 'overhead';

interface Preset {
  label: string;
  pitch: number;
  zoom: number;
  hint: string;
}

/**
 * 視点モードの設定。どちらも中心は出題地点のままなので、
 * 切り替えても立ち位置は変わらない。
 */
export const PRESETS: Record<ViewPreset, Preset> = {
  first_person: {
    label: '一人称',
    // 立っているように見せるには、地点のすぐそばまでカメラを寄せる必要がある
    pitch: 84,
    zoom: 17.4,
    hint: 'その場に立って見回している視点',
  },
  overhead: {
    label: '俯瞰',
    pitch: 52,
    zoom: 14.2,
    hint: '斜め上から地形の広がりを見る',
  },
};

const SOURCE_ROUTE = 'yg-local-route';
const LAYER_ROUTE_HALO = 'yg-local-route-halo';
const LAYER_ROUTE = 'yg-local-route-line';

/**
 * 俯角 [deg]。MapLibre の pitch と同じ定義で、
 * 0 = 真下を見下ろす（自分の地点が画面中央）、85 = ほぼ水平。
 */
const MIN_PITCH = 0;
const MAX_PITCH = 85;
/**
 * 寄り引きの範囲。地点からどれくらい離れて見るか。
 *
 * MapLibre のカメラは「中心（＝出題地点）からズームで決まる距離」に置かれる。
 * 一人称らしくするには相当寄せる必要があるので、上限を大きめに取っている。
 */
const MIN_ZOOM = 13;
const MAX_ZOOM = 19;
/** ドラッグ量に対する回転の感度 */
const YAW_PER_PX = 0.25;
const PITCH_PER_PX = 0.2;

const SOURCE_HERE = 'yg-here';
const LAYER_HERE = 'yg-here-circle';
const LAYER_HERE_RING = 'yg-here-ring';

export interface Terrain3DOptions {
  center: LatLng;
  /** 初期の視線方位（真北基準・時計回り） */
  headingDeg: number;
  /** 立っている地面の標高 [m]。表示にのみ使う */
  groundElevationM?: number | undefined;
  /** 足元のルートを描くためのトラック。無ければ描かない */
  track?: TrackFeature | null;
  /** 視点モードが変わったときに呼ばれる（UIの選択状態を合わせるため） */
  onPresetChange?: ((preset: ViewPreset) => void) | undefined;
}

/** 方位を「北」「北東」…の日本語表記にする。数字だけに頼らないため。 */
export function compassLabel(bearingDeg: number): string {
  const names = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const index = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return names[index] ?? '北';
}

/** 俯角の説明。今どちらを向いているかを言葉でも出す。 */
export function pitchLabel(pitch: number): string {
  if (pitch <= 12) return '真下';
  if (pitch <= 45) return '見下ろし';
  if (pitch <= 70) return 'やや見下ろし';
  return '水平';
}

export class Terrain3D {
  readonly map: MapLibreMap;
  private center: LatLng;
  private bearing: number;
  private preset: ViewPreset = 'first_person';
  private pitch = PRESETS.first_person.pitch;
  private zoom = PRESETS.first_person.zoom;
  private groundElevation = 0;
  private track: TrackFeature | null;
  private ready = false;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly hud: HTMLElement;
  private readonly onPresetChange: ((preset: ViewPreset) => void) | undefined;

  constructor(container: HTMLElement, options: Terrain3DOptions) {
    registerGsiDemProtocol();
    this.center = options.center;
    this.bearing = options.headingDeg;
    this.groundElevation = options.groundElevationM ?? 0;
    this.track = options.track ?? null;
    this.onPresetChange = options.onPresetChange;

    this.map = new MapLibreMap({
      container,
      style: terrainStyle(),
      center: [options.center.lon, options.center.lat],
      zoom: this.zoom,
      pitch: this.pitch,
      bearing: options.headingDeg,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxPitch: MAX_PITCH,
      attributionControl: false,
      // 立ち位置が動く操作は全部切る。動かせるのは向きと寄り引きだけ
      dragPan: false,
      dragRotate: false,
      boxZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      touchPitch: false,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: GSI_ATTRIBUTION }),
      'bottom-right',
    );
    // 寄り引きは画面中心（＝出題地点）を軸にする。カーソル位置を軸にすると地点がずれる
    this.map.scrollZoom.enable({ around: 'center' });
    this.map.touchZoomRotate.enable({ around: 'center' });

    if (import.meta.env.DEV) {
      (window as unknown as { __terrain?: Terrain3D }).__terrain = this;
    }

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      'この地点から見た3D地形。ドラッグまたは矢印キーで360度見回せます。' +
        '下を向くと自分がいる地点が中央に見えます。地名は表示されません。',
    );
    canvas.style.cursor = 'grab';

    this.hud = document.createElement('div');
    this.hud.className = 'terrain-hud';
    container.appendChild(this.hud);

    this.bindLookAround(canvas);
    // 寄り引きされたら内部の状態も合わせておく
    this.map.on('zoomend', () => {
      this.zoom = this.map.getZoom();
    });
    this.map.on('rotate', () => {
      this.bearing = (((this.map.getBearing() % 360) + 360) % 360);
      this.renderHud();
    });
    this.map.on('load', () => {
      // 地形はスタイル読み込みが終わってから入れる
      this.map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      this.ready = true;
      this.addHereMarker();
      this.renderLocalRoute();
      this.apply();
    });
    this.renderHud();
  }

  // -------------------------------------------------------------------------
  // 視点
  // -------------------------------------------------------------------------
  /**
   * 出題地点を中心に据えたまま、向きと寄り引きだけを反映する。
   * center を動かさないので、どれだけ回しても立ち位置は変わらない。
   */
  private apply(): void {
    this.renderHud();
    if (!this.ready) return;
    this.map.jumpTo({
      center: [this.center.lon, this.center.lat],
      zoom: this.zoom,
      bearing: this.bearing,
      pitch: this.pitch,
    });
  }

  private look(deltaYaw: number, deltaPitch: number): void {
    this.bearing = (((this.bearing + deltaYaw) % 360) + 360) % 360;
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + deltaPitch));
    this.apply();
  }

  private bindLookAround(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return; // タッチは MapLibre のジェスチャに任せる
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
      // 右にドラッグすると景色が右に流れる（＝視線は左へ）
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

  /** 真下を向く。自分がいる地点が画面の中央に来る。 */
  lookDown(): void {
    this.pitch = MIN_PITCH;
    this.apply();
  }

  /** 視点モードを切り替える。中心は動かないので立ち位置は変わらない。 */
  setPreset(preset: ViewPreset): void {
    this.preset = preset;
    const config = PRESETS[preset];
    this.pitch = config.pitch;
    this.zoom = config.zoom;
    this.apply();
    this.onPresetChange?.(preset);
  }

  currentPreset(): ViewPreset {
    return this.preset;
  }

  // -------------------------------------------------------------------------
  // 立ち位置の表示
  // -------------------------------------------------------------------------
  /** 出題地点に現在地の印を描く。見下ろすと自分の立っている場所が分かる。 */
  private addHereMarker(): void {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [this.center.lon, this.center.lat] },
    };
    const source = this.map.getSource(SOURCE_HERE);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(feature);
      return;
    }
    this.map.addSource(SOURCE_HERE, { type: 'geojson', data: feature });
    this.map.addLayer({
      id: LAYER_HERE_RING,
      type: 'circle',
      source: SOURCE_HERE,
      paint: {
        'circle-radius': 26,
        'circle-color': '#e8a33d',
        'circle-opacity': 0.2,
        'circle-stroke-color': '#e8a33d',
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.7,
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
   * 足元のルートだけを描く。
   *
   * **ルート全体を描かない。** 3Dに全体を出すと、地形図を見なくても
   * どこを歩いているかが分かってしまう。進む向きが読める最小限（前後10m）に絞る。
   */
  private renderLocalRoute(): void {
    const segment = this.track
      ? localRouteSegment(this.track, this.center, LOCAL_ROUTE_RADIUS_M)
      : null;
    if (!segment) {
      this.clearLocalRoute();
      return;
    }
    const data = segment as unknown as GeoJSON.Feature;
    const source = this.map.getSource(SOURCE_ROUTE);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(data);
      return;
    }
    this.map.addSource(SOURCE_ROUTE, { type: 'geojson', data });
    this.map.addLayer({
      id: LAYER_ROUTE_HALO,
      type: 'line',
      source: SOURCE_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.8 },
    });
    this.map.addLayer({
      id: LAYER_ROUTE,
      type: 'line',
      source: SOURCE_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#c2410c', 'line-width': 5 },
    });
  }

  private clearLocalRoute(): void {
    for (const id of [LAYER_ROUTE, LAYER_ROUTE_HALO]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource(SOURCE_ROUTE)) this.map.removeSource(SOURCE_ROUTE);
  }

  /** トラックを差し替える（山が変わったとき）。 */
  setTrack(track: TrackFeature | null): void {
    this.track = track;
    if (this.ready) this.renderLocalRoute();
  }

  private renderHud(): void {
    const elevation = this.groundElevation > 0
      ? `<span class="terrain-hud__ele num">標高 ${Math.round(this.groundElevation)} m</span>`
      : '';
    this.hud.innerHTML = `
      <span class="terrain-hud__here">この地点</span>
      <span class="terrain-hud__facing num">${Math.round(this.bearing)}°</span>
      <span class="terrain-hud__dir">${compassLabel(this.bearing)}向き・${pitchLabel(this.pitch)}</span>
      ${elevation}
    `;
  }

  /** 足元のルートの説明。凡例として画面に出す。 */
  static routeLegend(): string {
    return `足元の朱線はルート（前後${LOCAL_ROUTE_RADIUS_M}m）`;
  }

  // -------------------------------------------------------------------------
  // 出し入れ
  // -------------------------------------------------------------------------
  /** 次の問題へ。立ち位置と初期の向きを移す。 */
  moveTo(center: LatLng, headingDeg: number, groundElevationM?: number): void {
    this.center = center;
    this.bearing = headingDeg;
    this.pitch = PRESETS[this.preset].pitch;
    this.zoom = PRESETS[this.preset].zoom;
    this.groundElevation = groundElevationM ?? 0;
    if (this.ready) {
      this.addHereMarker();
      this.renderLocalRoute();
    }
    this.apply();
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.hud.remove();
    this.map.remove();
  }
}
