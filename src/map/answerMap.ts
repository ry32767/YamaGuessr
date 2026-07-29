/**
 * 回答用の2D地形図（機能F・機能Gで共通）。
 *
 * クリック／タップで推測地点を置き、回答後に正解・距離リング（シグネチャ）を出す。
 * ポインタが使えない場合に備え、地図にフォーカスして Enter でも地点を置ける。
 */
import maplibregl, { Map as MapLibreMap, Marker, type GeoJSONSource } from 'maplibre-gl';
import type { LatLng } from '../scoring';
import type { TrackFeature } from '../types';
import { GSI_ATTRIBUTION, baseMapStyle } from './style';
import { clearRings, showRings } from './rings';

const SOURCE_TRACK = 'yg-track';
const LAYER_TRACK_HALO = 'yg-track-halo';
const LAYER_TRACK = 'yg-track-line';

export interface AnswerMapOptions {
  center: LatLng;
  zoom?: number;
  onGuessChange?: (guess: LatLng) => void;
}

function markerElement(kind: 'guess' | 'actual'): HTMLElement {
  const el = document.createElement('div');
  el.className = `yg-marker yg-marker--${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', kind === 'guess' ? 'あなたの推測地点' : '正解の地点');
  return el;
}

export class AnswerMap {
  readonly map: MapLibreMap;
  private guess: LatLng | null = null;
  private guessMarker: Marker | null = null;
  private actualMarker: Marker | null = null;
  private readonly onGuessChange: ((guess: LatLng) => void) | undefined;
  private locked = false;

  constructor(container: HTMLElement, options: AnswerMapOptions) {
    this.onGuessChange = options.onGuessChange;
    this.map = new MapLibreMap({
      container,
      style: baseMapStyle('std'),
      center: [options.center.lon, options.center.lat],
      zoom: options.zoom ?? 12,
      attributionControl: false,
      // タッチでの回転は誤操作が多いので切る（ピンチズームとパンは有効）
      touchPitch: false,
      dragRotate: false,
    });
    // 出典表示は常時。compact にせず必ず見えるようにする
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: GSI_ATTRIBUTION }),
      'bottom-right',
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }));

    this.map.on('click', (e) => {
      if (this.locked) return;
      this.setGuess({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      '地形図。クリックまたはタップで推測地点を置きます。矢印キーで移動し、Enterで画面中央に置けます。',
    );
    canvas.addEventListener('keydown', (event) => {
      if (this.locked) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const center = this.map.getCenter();
      this.setGuess({ lat: center.lat, lon: center.lng });
    });
  }

  /** 推測地点を置く（同じ地点をもう一度押しても位置は上書きされる）。 */
  setGuess(latlng: LatLng): void {
    this.guess = latlng;
    if (!this.guessMarker) {
      this.guessMarker = new Marker({ element: markerElement('guess') })
        .setLngLat([latlng.lon, latlng.lat])
        .addTo(this.map);
    } else {
      this.guessMarker.setLngLat([latlng.lon, latlng.lat]);
    }
    this.onGuessChange?.(latlng);
  }

  getGuess(): LatLng | null {
    return this.guess;
  }

  /** 回答後の表示。正解・結ぶ線・距離リングを出し、以後クリックを受け付けない。 */
  reveal(actual: LatLng, distanceM: number): void {
    const guess = this.guess;
    if (!guess) return;
    this.locked = true;
    this.actualMarker = new Marker({ element: markerElement('actual') })
      .setLngLat([actual.lon, actual.lat])
      .addTo(this.map);

    // スタイル読み込み前に addSource すると例外になる。
    // 出題直後にすぐ回答された場合でも落ちないよう、読み込みを待ってから描く。
    this.whenStyleReady(() => showRings(this.map, actual, guess, distanceM));

    const bounds = new maplibregl.LngLatBounds(
      [Math.min(actual.lon, guess.lon), Math.min(actual.lat, guess.lat)],
      [Math.max(actual.lon, guess.lon), Math.max(actual.lat, guess.lat)],
    );
    this.map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 600 });
  }

  private whenStyleReady(fn: () => void): void {
    if (this.map.isStyleLoaded()) {
      fn();
      return;
    }
    this.map.once('load', fn);
  }

  /**
   * 歩いたGPXトラックを地形図に重ねる。
   *
   * 「このルートのどこか」が分かることで、当てる問題が線の上の一次元になり、
   * 手がかりの無い当てずっぽうにならない。白いハローを下に敷いて、
   * 地形図の等高線や道路の上でも線が埋もれないようにしている。
   */
  showTrack(track: TrackFeature | null): void {
    if (!track) {
      this.clearTrack();
      return;
    }
    this.whenStyleReady(() => {
      const source = this.map.getSource(SOURCE_TRACK);
      if (source && 'setData' in source) {
        (source as GeoJSONSource).setData(track as unknown as GeoJSON.Feature);
        return;
      }
      this.map.addSource(SOURCE_TRACK, {
        type: 'geojson',
        data: track as unknown as GeoJSON.Feature,
      });
      this.map.addLayer({
        id: LAYER_TRACK_HALO,
        type: 'line',
        source: SOURCE_TRACK,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 },
      });
      this.map.addLayer({
        id: LAYER_TRACK,
        type: 'line',
        source: SOURCE_TRACK,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c2410c', 'line-width': 3 },
      });
    });
  }

  private clearTrack(): void {
    for (const id of [LAYER_TRACK, LAYER_TRACK_HALO]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource(SOURCE_TRACK)) this.map.removeSource(SOURCE_TRACK);
  }

  /** 次の問題へ。マーカーとリングを消して中心を移す。 */
  reset(center: LatLng, zoom = 12): void {
    this.locked = false;
    this.guess = null;
    this.guessMarker?.remove();
    this.guessMarker = null;
    this.actualMarker?.remove();
    this.actualMarker = null;
    clearRings(this.map);
    this.map.jumpTo({ center: [center.lon, center.lat], zoom });
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.map.remove();
  }
}
