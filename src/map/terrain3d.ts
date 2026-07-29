/**
 * モード②の3D地形ビュー（機能G）。
 *
 * **地形図タイルを地形テクスチャに使わない。** 山名・三角点・注記が焼き込まれており、
 * 答えが画面に表示されてしまう（docs/spec.md 設計判断表）。描くのは陰影起伏だけ。
 */
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../scoring';
import { GSI_ATTRIBUTION, registerGsiDemProtocol, terrainStyle } from './style';

export interface Terrain3DOptions {
  center: LatLng;
  /** 初期カメラ方位（真北基準・時計回り） */
  headingDeg: number;
  zoom?: number;
  pitch?: number;
}

export class Terrain3D {
  readonly map: MapLibreMap;

  constructor(container: HTMLElement, options: Terrain3DOptions) {
    registerGsiDemProtocol();
    this.map = new MapLibreMap({
      container,
      style: terrainStyle(),
      center: [options.center.lon, options.center.lat],
      zoom: options.zoom ?? 13.5,
      pitch: options.pitch ?? 72,
      bearing: options.headingDeg,
      maxPitch: 85,
      attributionControl: false,
      // 3Dは見回しが主目的なので、タッチでの回転・傾斜を有効にする
      touchPitch: true,
      dragRotate: true,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: GSI_ATTRIBUTION }),
      'bottom-right',
    );
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      'この地点の周辺の3D地形。ドラッグまたはタッチで見回し、ピンチで拡大縮小できます。地名は表示されません。',
    );
  }

  /** 次の問題へ。地点と初期方位を移す。 */
  moveTo(center: LatLng, headingDeg: number, zoom = 13.5): void {
    this.map.jumpTo({
      center: [center.lon, center.lat],
      zoom,
      bearing: headingDeg,
      pitch: 72,
    });
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.map.remove();
  }
}
