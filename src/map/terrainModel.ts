/**
 * モード②の3D地形ビュー（機能G）＝**3人称**。
 *
 * 出題地点を中心に、周りの地形モデルを**外から回して眺める**。地面に立って見る
 * 一人称（[terrain3d.ts](terrain3d.ts)）とは役割が違い、こちらは
 * 「この形の地形は地形図のどこか」を読む問題になる。
 *
 * **ルート（朱線）は描かない。** 2Dの地形図には歩いたルートが描いてあるので、
 * 3D側にも描くと線の形を見比べるだけで当たってしまい、地形を読む問題にならない。
 * 描くのは出題地点のマーカーだけ。
 *
 * テクスチャは一人称と同じ空中写真。**地形図タイル（標準地図・淡色地図）は貼らない**
 * ——山名・三角点・注記が焼き込まれていて答えが画面に出る（docs/spec.md 設計判断表）。
 */
import maplibregl, { LngLat, Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../scoring';
import { compassLabel } from './terrain3d';
import {
  GSI_ATTRIBUTION,
  TERRAIN_EXAGGERATION,
  TERRAIN_QUERY_ZOOM,
  TERRAIN_SOURCE,
  registerGsiDemProtocol,
  terrainStyle,
} from './style';

/** 初期の見え方。真上でも真横でもない、地形の起伏がいちばん読める角度 */
const START_PITCH = 62;
const START_ZOOM = 14.2;
/**
 * ズームの範囲。
 *
 * 下限は「山ひとつが画面に入る」あたり、上限は「尾根や谷の形が分かる」あたり。
 * 標高タイルはz14までなので、それ以上寄せても形は細かくならない（写真だけが寄る）。
 */
const MIN_ZOOM = 12;
const MAX_ZOOM = 16.5;
/** 見下ろし角の範囲。0＝真上から、大きいほど水平に近い */
const MIN_PITCH = 0;
const MAX_PITCH = 78;

/** ドラッグ量に対する感度 */
const BEARING_PER_PX = 0.3;
const PITCH_PER_PX = 0.2;

export interface TerrainModelOptions {
  /** 出題地点。ここを中心に回す */
  center: LatLng;
  /** 地点の標高 [m]。地形タイルが届く前の表示に使う */
  groundElevationM?: number | undefined;
}

export class TerrainModel {
  readonly map: MapLibreMap;
  private center: LatLng;
  private groundElevationM: number;
  private ready = false;
  private marker: maplibregl.Marker | null = null;
  /**
   * 最後にカメラへ渡した地面の高さ [m]（描画空間＝強調込み）。
   * 標高タイルが遅れて届いて値が変わったら、カメラを入れ直す（`syncGround`）。
   */
  private appliedGroundM: number | null = null;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly hud: HTMLElement;

  constructor(container: HTMLElement, options: TerrainModelOptions) {
    registerGsiDemProtocol();
    this.center = options.center;
    this.groundElevationM = options.groundElevationM ?? 0;

    this.map = new MapLibreMap({
      container,
      style: terrainStyle(),
      center: [options.center.lon, options.center.lat],
      zoom: START_ZOOM,
      // **北を上から始める。** 毎回同じ向きで始めれば、向き自体が手がかりにならない
      bearing: 0,
      pitch: START_PITCH,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxPitch: MAX_PITCH,
      attributionControl: false,
      // 中心は出題地点に固定する。パンできると「中心＝答え」が崩れて何を見ているか分からなくなる
      dragPan: false,
      dragRotate: false,
      boxZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      touchPitch: false,
      scrollZoom: false,
      touchZoomRotate: false,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: GSI_ATTRIBUTION }),
      'bottom-right',
    );

    if (import.meta.env.DEV) {
      (window as unknown as { __model?: TerrainModel }).__model = this;
    }

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      '出題地点を中心にした3D地形モデル。ドラッグまたは矢印キーで回り込み、' +
        'ホイールか +/- キーで寄り引きできます。地名は表示されません。',
    );
    canvas.style.cursor = 'grab';

    this.hud = document.createElement('div');
    this.hud.className = 'terrain-hud';
    container.appendChild(this.hud);

    this.bindPointer(canvas);
    this.bindWheel(canvas);
    this.bindKeys(canvas);

    this.map.on('load', () => {
      this.map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      this.ready = true;
      this.addMarker();
      this.renderHud();
    });
    this.map.on('move', () => this.renderHud());
    this.map.on('sourcedata', (e) => {
      if (e.sourceId === TERRAIN_SOURCE) this.renderHud();
    });
    // 標高が届くのは「地点を移したあと」なので、イベントではなく毎フレーム見張る。
    // sourcedata だけだと、タイルがキャッシュ済みで再取得が起きない場合に取りこぼす
    this.map.on('render', () => this.syncGround());
    this.renderHud();
  }

  // -------------------------------------------------------------------------
  // 操作（中心は動かさない。回り込みと寄り引きだけ）
  // -------------------------------------------------------------------------
  /**
   * カメラを置き直す。**`elevation` を必ず渡す。**
   *
   * 渡さないと `centerClampedToGround` 任せになるが、これが当てにならない。
   * 中心標高が 0 に落ちたまま戻らないことがあり、そうなるとマーカーが
   * 「海面にあるこの緯度経度」の位置に描かれる——つまり**標高のぶんだけ
   * ピンが宙に浮く**（氷ノ山の1296m地点で実測506px）。地面の高さは
   * こちらが知っているので、毎回明示して渡す。
   */
  private applyCamera(bearing: number, pitch: number, zoom: number): void {
    const ground = this.groundElevationRendered();
    this.appliedGroundM = ground;
    this.map.jumpTo({
      center: [this.center.lon, this.center.lat],
      bearing,
      pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch)),
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
      elevation: ground,
    });
  }

  private orbit(deltaBearing: number, deltaPitch: number): void {
    this.applyCamera(
      this.map.getBearing() + deltaBearing,
      this.map.getPitch() + deltaPitch,
      this.map.getZoom(),
    );
  }

  private zoomBy(delta: number): void {
    this.applyCamera(this.map.getBearing(), this.map.getPitch(), this.map.getZoom() + delta);
  }

  /**
   * 標高タイルが遅れて届いたら、カメラを入れ直して地面に合わせる。
   *
   * 地点を移した直後はその場所の標高がまだ分からないので、出題データの値で
   * 仮に置いておき、実際のタイルが来た時点でここが拾って合わせ直す。
   * 毎フレーム走るので、変化が無ければ即座に返す。
   */
  private syncGround(): void {
    if (!this.ready) return;
    const ground = this.groundElevationRendered();
    // 0.5m未満の揺れは標高タイルの精度の範囲。入れ直すと無駄に描画が走る
    if (this.appliedGroundM !== null && Math.abs(ground - this.appliedGroundM) < 0.5) return;
    this.applyCamera(this.map.getBearing(), this.map.getPitch(), this.map.getZoom());
    this.renderHud();
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      if (this.dragPointerId !== null) return;
      this.dragPointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 取れなくても回せる
      }
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragPointerId !== e.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // 右へ引くと地形が右に回る（模型を手で回す感覚）
      this.orbit(-dx * BEARING_PER_PX, dy * PITCH_PER_PX);
    });
    const end = (e: PointerEvent): void => {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragPointerId = null;
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private bindWheel(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? -0.25 : 0.25);
      },
      { passive: false },
    );
  }

  private bindKeys(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('keydown', (e) => {
      const turn = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft') this.orbit(-turn, 0);
      else if (e.key === 'ArrowRight') this.orbit(turn, 0);
      else if (e.key === 'ArrowUp') this.orbit(0, -3);
      else if (e.key === 'ArrowDown') this.orbit(0, 3);
      else if (e.key === '+' || e.key === '=') this.zoomBy(0.5);
      else if (e.key === '-') this.zoomBy(-0.5);
      else return;
      e.preventDefault();
    });
  }

  /** 外（ボタン）から使う操作。 */
  turn(deltaBearing: number): void {
    this.orbit(deltaBearing, 0);
  }

  zoom(delta: number): void {
    this.zoomBy(delta);
  }

  /** 初期の見え方（北が上・斜め上から）に戻す。 */
  resetView(): void {
    this.applyCamera(0, START_PITCH, START_ZOOM);
  }

  // -------------------------------------------------------------------------
  // 描くもの
  // -------------------------------------------------------------------------
  /**
   * 出題地点のマーカー。
   *
   * **どこを当てるのかを示すためのもの**で、答えを漏らしてはいない
   * （中心が出題地点であることは画面の説明にも書いてある）。
   */
  private addMarker(): void {
    if (this.marker) {
      this.marker.setLngLat([this.center.lon, this.center.lat]);
      return;
    }
    const element = document.createElement('div');
    element.className = 'terrain-pin';
    const label = document.createElement('span');
    label.className = 'terrain-pin__label';
    label.textContent = 'この地点';
    const dot = document.createElement('span');
    dot.className = 'terrain-pin__dot';
    element.append(label, dot);
    // 尾根の裏に回り込んだら消す（既定の0.2だと地形越しに透けて見えてしまう）
    this.marker = new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0' })
      .setLngLat([this.center.lon, this.center.lat])
      .addTo(this.map);
  }

  /**
   * 中心の地面の高さ [m]、**描画空間の値**（＝実標高×強調度）。
   *
   * `map.jumpTo({elevation})` も `getCenterElevation()` も強調込みの値を扱うので、
   * カメラに渡すのはこちら。地形タイルが届く前は出題データの標高で代用する。
   */
  private groundElevationRendered(): number {
    const terrain: MapLibreMap['terrain'] | undefined = this.map.terrain;
    if (this.ready && terrain) {
      const value = terrain.getElevationForLngLatZoom(
        new LngLat(this.center.lon, this.center.lat),
        TERRAIN_QUERY_ZOOM,
      );
      if (value !== 0 && Number.isFinite(value)) return value;
    }
    return this.groundElevationM * TERRAIN_EXAGGERATION;
  }

  /** 地点の実標高 [m]。HUDに出す値なので強調は戻す。 */
  private elevationM(): number {
    return this.groundElevationRendered() / TERRAIN_EXAGGERATION;
  }

  private renderHud(): void {
    // 3人称では「どちらが北か」が分からなくなるので、画面の向きを常に出す
    const bearing = ((this.map.getBearing() % 360) + 360) % 360;
    const elevation = this.elevationM();
    const parts = [
      '<span class="terrain-hud__here">この地点</span>',
      `<span class="terrain-hud__facing num">${Math.round(bearing)}°</span>`,
      `<span class="terrain-hud__dir">画面の上は${compassLabel(bearing)}</span>`,
    ];
    if (elevation > 0) {
      parts.push(`<span class="terrain-hud__ele num">標高 ${Math.round(elevation)} m</span>`);
    }
    this.hud.innerHTML = parts.join('\n');
  }

  /** 操作の説明。凡例として画面に出す。 */
  static legend(): string {
    return 'ドラッグで回り込み、ホイールで寄り引き。中心の印が出題地点';
  }

  // -------------------------------------------------------------------------
  // 出し入れ
  // -------------------------------------------------------------------------
  /** 次の問題へ。中心を移して見え方を初期化する。 */
  moveTo(center: LatLng, groundElevationM?: number): void {
    this.center = center;
    this.groundElevationM = groundElevationM ?? 0;
    if (this.ready) this.addMarker();
    // 新しい地点の標高はまだ分からない。出題データの値で仮に置き、
    // 実際の標高タイルが届いた時点で syncGround が合わせ直す
    this.appliedGroundM = null;
    this.resetView();
    this.renderHud();
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.marker?.remove();
    this.hud.remove();
    this.map.remove();
  }
}
