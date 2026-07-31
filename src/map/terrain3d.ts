/**
 * モード②の3D地形ビュー（機能G）。
 *
 * **ルートに立って見回し、ルートの上を歩く。** Googleストリートビューと同じ操作感で、
 * カメラは実際に地面＋目線の高さ（[eye.ts](eye.ts) の `EYE_HEIGHT_M`）に置く。
 * 見下ろし角には上限があり、**俯瞰（上空から見下ろす画）にはならない**。
 * 上から見せると「自分がどこに立っているか」が伝わらないため（DESIGN.md 不変条件2b）。
 *
 * ルートは全体を描き、出題地点にはピンを立てる。
 * ただし一人称なので、尾根の裏に回ったぶんは地形に隠れて見えない。
 *
 * **地形図タイルを地形テクスチャに使わない。** 山名・三角点・注記が焼き込まれており、
 * 答えが画面に表示されてしまう（docs/spec.md 設計判断表）。貼るのは空中写真。
 */
import maplibregl, { LngLat, Map as MapLibreMap, type CameraOptions } from 'maplibre-gl';
import { distanceMeters, type LatLng } from '../scoring';
import type { TrackFeature } from '../types';
import {
  EYE_HEIGHT_M,
  MAX_DOWN_DEG,
  MIN_DOWN_DEG,
  aimAtTerrain,
} from './eye';
import { RoutePath, angleDiffDeg } from './route';
import {
  GSI_ATTRIBUTION,
  TERRAIN_EXAGGERATION,
  TERRAIN_QUERY_ZOOM,
  TERRAIN_SOURCE,
  registerGsiDemProtocol,
  terrainStyle,
} from './style';

/** 1回の操作で歩く距離 [m]。ストリートビューの1歩ぶんの感覚に合わせた */
export const STEP_M = 25;
/** Shiftを押しながら／長押しで歩く距離 [m] */
export const LONG_STEP_M = 100;
/** 歩く速さ。1mあたりの時間 [ms] と、その下限・上限 */
const WALK_MS_PER_M = 9;
const WALK_MIN_MS = 260;
const WALK_MAX_MS = 900;
/** タップした場所からこの距離までルートがあれば、そこへ移動する */
const TAP_SNAP_M = 60;
/** 出題地点のピンを出し始める距離 [m]（足元にあるうちは視界を塞ぐだけなので出さない） */
const START_PIN_AFTER_M = 12;
/**
 * 地形が落ち着くまで視点を解き直す回数。
 *
 * 標高タイルは少しずつ届くので、届くたびに地形の形が変わる。読み込み途中の形で
 * 決めた視点は的を外していることがあるため、何度か解き直す。
 * 解き直しても答えが変わらなければ何もしない（`sameAsCurrent`）ので、そこで止まる。
 */
const SETTLE_APPLIES = 8;

/** ドラッグ量に対する感度 */
const YAW_PER_PX = 0.25;
const DOWN_PER_PX = 0.12;
/** これ未満の動きはタップ扱い（見回しではない） */
const TAP_SLOP_PX = 6;

const SOURCE_ROUTE = 'yg-route';
const LAYER_ROUTE_HALO = 'yg-route-halo';
const LAYER_ROUTE = 'yg-route-line';
const SOURCE_START = 'yg-start';
const LAYER_START = 'yg-start-circle';
const LAYER_START_RING = 'yg-start-ring';

/**
 * ズームの範囲。ズームは「見ている先までの距離」から決まる（[eye.ts](eye.ts)）ので、
 * 直接いじる操作は無い。
 *
 * 上限を21で止めているのは、MapLibreの近クリップ面が約6mあるため。
 * 目の前の斜面（数m先）を狙うとその面より内側になり、地形が1枚も描かれなくなる。
 * 上限に当たったときはカメラが視線の後ろへ十数m下がるが、位置の誤差は採点に響かない。
 */
const MIN_ZOOM = 13;
const MAX_ZOOM = 21;

export interface Terrain3DOptions {
  /** 出題地点。ここに立って始める */
  center: LatLng;
  /** 初期の視線方位（真北基準・時計回り） */
  headingDeg: number;
  /** 立っている地面の標高 [m]。地形タイルが届く前の視点計算に使う */
  groundElevationM?: number | undefined;
  /** 歩けるルート。無ければその場から動けない */
  track?: TrackFeature | null;
  /** 移動状態が変わったときに呼ばれる（UIの活殺を合わせるため） */
  onWalk?: ((state: WalkState) => void) | undefined;
}

export interface WalkState {
  /** 出発地点からルート上を移動した距離 [m] */
  movedM: number;
  /** 歩けるか（ルートが登録されているか） */
  canWalk: boolean;
}

/** 歩き出しと止まりを柔らかくする（等速だと機械が動いたように見える）。 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** 方位を「北」「北東」…の日本語表記にする。数字だけに頼らないため。 */
export function compassLabel(bearingDeg: number): string {
  const names = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const index = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return names[index] ?? '北';
}

export class Terrain3D {
  readonly map: MapLibreMap;
  /** 出題地点（＝出発地点）。回答の正解はここ */
  private start: LatLng;
  private trackData: TrackFeature | null = null;
  private route: RoutePath | null = null;
  /** 出発地点がルートに乗っているか。乗っていなければ歩けない */
  private onRoute = false;
  private startAlongM = 0;
  private alongM = 0;
  private bearing: number;
  private downDeg = MIN_DOWN_DEG;
  /** 出題データ由来の実標高 [m]。地形タイルが届く前の代用に使う */
  private groundElevationM: number;
  private ready = false;
  private frame: number | null = null;
  /** 歩いている最中のアニメーション */
  private walkFrame: number | null = null;
  /** 地形が変わるたびに解き直すが、揺れ続けないよう回数を絞る */
  private settleBudget = SETTLE_APPLIES;
  /** MapLibreに視点を書き換えられて解き直した回数（際限なく繰り返さないため） */
  private rewrites = 0;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragTravel = 0;
  private note: string | null = null;
  private noteTimer: number | null = null;
  private startPin: maplibregl.Marker | null = null;
  private readonly hud: HTMLElement;
  private readonly onWalk: ((state: WalkState) => void) | undefined;

  constructor(container: HTMLElement, options: Terrain3DOptions) {
    registerGsiDemProtocol();
    this.start = options.center;
    this.bearing = options.headingDeg;
    this.groundElevationM = options.groundElevationM ?? 0;
    this.onWalk = options.onWalk;

    this.map = new MapLibreMap({
      container,
      style: terrainStyle(),
      center: [options.center.lon, options.center.lat],
      zoom: 17,
      pitch: 90 - MIN_DOWN_DEG,
      bearing: options.headingDeg,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // 既定の上限は60度。これだと目線の高さに立てないので、MapLibreの上限まで開ける
      maxPitch: 90 - MIN_DOWN_DEG,
      attributionControl: false,
      // カメラはこのクラスが全部決める。MapLibre側の操作は全部切る
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
    this.setTrack(options.track ?? null);

    if (import.meta.env.DEV) {
      (window as unknown as { __terrain?: Terrain3D }).__terrain = this;
    }

    const canvas = this.map.getCanvas();
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      'この地点に立って見た3D地形。ドラッグまたは左右キーで見回し、' +
        '上下キーかボタンでルートの上を前後に移動できます。地名は表示されません。',
    );
    canvas.style.cursor = 'grab';

    this.hud = document.createElement('div');
    this.hud.className = 'terrain-hud';
    container.appendChild(this.hud);

    this.bindPointer(canvas);
    this.bindKeys(canvas);
    this.map.on('load', () => {
      // 地形はスタイル読み込みが終わってから入れる
      this.map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
      this.ready = true;
      this.addStartMarker();
      this.renderRoute();
      this.restartSettle();
      this.apply();
    });
    // 標高タイルが届くたびに地形の形が変わる。届いたら視点を解き直す
    // （解き直しても答えが変わらなければ `sameAsCurrent` で何もしないので止まる）
    this.map.on('sourcedata', (e) => {
      if (e.sourceId !== TERRAIN_SOURCE) return;
      this.restartSettle();
      this.schedule();
    });
    this.map.on('idle', () => {
      if (this.settleBudget <= 0) return;
      this.settleBudget -= 1;
      this.apply();
    });
    this.renderHud();
  }

  // -------------------------------------------------------------------------
  // 視点
  // -------------------------------------------------------------------------
  /** 立っている場所。ルートに乗っていればその上、無ければ出題地点。 */
  private eye(): LatLng {
    return this.route && this.onRoute ? this.route.positionAt(this.alongM) : this.start;
  }

  /**
   * 地形の標高 [m]（誇張後）。
   *
   * **必ず同じズーム（標高タイルの最大ズーム）で読む。** `map.queryTerrainElevation` は
   * そのときの表示ズームで読むため、視線を振ってズームが変わると同じ場所の標高が
   * 数十cm変わる。それをそのまま視点に反映すると、首を振るだけで頭が上下する。
   *
   * **標高タイルが未着の場所はちょうど0が返る**（MapLibreの仕様。地理院の欠測も0にしてある）。
   * これをそのまま海面として扱うと「一面が海まで落ちている地形」を狙ってしまうので、
   * 未着は「自分と同じ高さ」とみなして平坦に扱う。
   */
  private elevationAt(p: LatLng, zoom: number = TERRAIN_QUERY_ZOOM): number {
    const terrain: MapLibreMap['terrain'] | undefined = this.map.terrain;
    if (!terrain) return this.fallbackElevation();
    const value = terrain.getElevationForLngLatZoom(new LngLat(p.lon, p.lat), zoom);
    return value === 0 || !Number.isFinite(value) ? this.fallbackElevation() : value;
  }

  /** 立っている地面の標高 [m]（誇張後）。 */
  private groundUnderEye(): number {
    return this.elevationAt(this.eye());
  }

  private fallbackElevation(): number {
    return this.groundElevationM * TERRAIN_EXAGGERATION;
  }

  /** 地形や立ち位置が変わったので、落ち着くまで解き直す枠を戻す。 */
  private restartSettle(): void {
    this.settleBudget = SETTLE_APPLIES;
    this.rewrites = 0;
  }

  /** 次のフレームで視点を解き直す。ドラッグ中に何度も呼ばれても1回にまとめる。 */
  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.apply();
    });
  }

  /**
   * 目の位置にカメラを立てる。
   *
   * **カメラの高さは「画面中央に据えた地面の標高 ＋ そこまでの水平距離×tan(見下ろし角)」**
   * になる（MapLibreは地形を有効にすると中心を必ず地面に置くため）。だから狙い先は
   * 視線が地面と交わる点でなければならず、それが取れて初めて目の高さに立てる。
   */
  private apply(): void {
    this.renderHud();
    if (!this.ready) return;
    const eye = this.eye();
    const eyeLngLat = new LngLat(eye.lon, eye.lat);
    const eyeAltitudeM = this.groundUnderEye() + EYE_HEIGHT_M * TERRAIN_EXAGGERATION;
    const aim = aimAtTerrain({
      eye,
      eyeAltitudeM,
      bearingDeg: this.bearing,
      downDeg: this.downDeg,
      elevationAt: (p) => this.elevationAt(p),
    });
    const targetLngLat = new LngLat(aim.target.lon, aim.target.lat);
    const solve = (targetAltitudeM: number): CameraOptions => {
      const camera = this.map.calculateCameraOptionsFromTo(
        eyeLngLat,
        eyeAltitudeM,
        targetLngLat,
        targetAltitudeM,
      );
      // MapLibre側でも丸められるが、丸めた値で比べないと同じ視点だと気づけない
      camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom ?? MAX_ZOOM));
      return camera;
    };
    // 狙い先の標高は**MapLibreが描画に使うズームで読み直す**。読み方がずれていると、
    // その差のぶんだけカメラが浮く（＝頭が上がる）。1度解いてから読み直して解き直す。
    const first = solve(aim.targetAltitudeM);
    const renderAltitudeM = this.elevationAt(aim.target, Math.floor(first.zoom ?? MAX_ZOOM));
    const options = renderAltitudeM === aim.targetAltitudeM ? first : solve(renderAltitudeM);
    if (this.sameAsCurrent(options)) return;
    this.map.jumpTo(options);
    // 中心の標高は次の描画まで更新されない。放っておくと1フレームだけ頭が上下するので、
    // ここで狙い先の標高に合わせておく（描画時に同じ値で上書きされる）。
    this.map.transform.elevation = renderAltitudeM;
    // MapLibreには「カメラが地形に潜ったら持ち上げる」保護がある。誤検知で視点を
    // 書き換えられたら次のフレームで解き直す。
    if (Math.abs(this.map.getPitch() - (options.pitch ?? 0)) > 0.5 && this.rewrites < 4) {
      this.rewrites += 1;
      this.settleBudget = SETTLE_APPLIES;
      this.schedule();
    }
  }

  /** 今のカメラとほぼ同じなら動かさない（無駄な再描画と解き直しの往復を止める）。 */
  private sameAsCurrent(options: CameraOptions): boolean {
    const center = options.center ? LngLat.convert(options.center) : null;
    if (!center) return false;
    const current = this.map.getCenter();
    return (
      Math.abs((options.zoom ?? 0) - this.map.getZoom()) < 0.02 &&
      Math.abs((options.pitch ?? 0) - this.map.getPitch()) < 0.05 &&
      Math.abs(angleDiffDeg(options.bearing ?? 0, this.map.getBearing())) < 0.05 &&
      Math.abs(center.lng - current.lng) < 1e-7 &&
      Math.abs(center.lat - current.lat) < 1e-7
    );
  }

  private look(deltaYaw: number, deltaDown: number): void {
    this.bearing = (((this.bearing + deltaYaw) % 360) + 360) % 360;
    this.downDeg = Math.max(MIN_DOWN_DEG, Math.min(MAX_DOWN_DEG, this.downDeg + deltaDown));
    this.restartSettle();
    this.schedule();
  }

  // -------------------------------------------------------------------------
  // ルートの上を歩く
  // -------------------------------------------------------------------------
  /**
   * 見ている向きへ歩く（負の距離で後ろへ）。
   *
   * ルートは1本の線なので、進む方向は「今向いている方位に近い側」で決める。
   * ストリートビューと同じで、振り向いて「進む」を押せば逆向きに歩ける。
   */
  walk(distanceM: number): void {
    const route = this.walkableRoute();
    if (!route) return;
    const forward = Math.abs(angleDiffDeg(route.bearingAt(this.alongM), this.bearing)) <= 90;
    const delta = forward ? distanceM : -distanceM;
    const next = Math.max(0, Math.min(route.totalM, this.alongM + delta));
    if (Math.abs(next - this.alongM) < 0.01) {
      this.flash('ルートの端です');
      return;
    }
    this.moveAlong(next);
  }

  /** 出発地点（＝出題地点）へ戻る。 */
  returnToStart(): void {
    if (!this.walkableRoute()) return;
    this.moveAlong(this.startAlongM);
  }

  /** ルートの上をタップして移動する。ルートから遠いタップは無視する。 */
  private walkToPoint(p: LatLng): void {
    const route = this.walkableRoute();
    if (!route) return;
    const anchor = route.anchorFor(p);
    if (anchor.offsetM > TAP_SNAP_M) {
      this.flash('ルート（朱線）の上をタップすると移動できます');
      return;
    }
    this.moveAlong(anchor.alongM);
  }

  /**
   * ルート上を滑らかに歩く。
   *
   * **瞬間移動にしない。** 一人称では景色が急に差し替わると、動いたのか
   * 別の場所に飛ばされたのか分からない。歩く距離に応じた時間をかけて詰める。
   */
  private moveAlong(target: number): void {
    const route = this.walkableRoute();
    if (!route) return;
    const from = this.alongM;
    const to = Math.max(0, Math.min(route.totalM, target));
    const distance = Math.abs(to - from);
    if (distance < 0.01) return;
    this.cancelWalkAnimation();
    this.restartSettle();

    // 動きを減らす設定の人には出さない（設定を尊重する。DESIGN.md）
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.alongM = to;
      this.afterWalk();
      return;
    }

    const duration = Math.max(WALK_MIN_MS, Math.min(WALK_MAX_MS, distance * WALK_MS_PER_M));
    const startedAt = performance.now();
    const step = (): void => {
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      this.alongM = from + (to - from) * easeInOut(progress);
      this.afterWalk();
      this.walkFrame = progress < 1 ? window.requestAnimationFrame(step) : null;
    };
    this.walkFrame = window.requestAnimationFrame(step);
  }

  private cancelWalkAnimation(): void {
    if (this.walkFrame === null) return;
    window.cancelAnimationFrame(this.walkFrame);
    this.walkFrame = null;
  }

  private afterWalk(): void {
    this.updateStartMarker();
    this.schedule();
    this.onWalk?.(this.walkState());
  }

  walkState(): WalkState {
    return { movedM: this.movedM(), canWalk: this.walkableRoute() !== null };
  }

  /** 歩けるルート。トラックが無い／出発地点がルートから離れているときは null。 */
  private walkableRoute(): RoutePath | null {
    return this.onRoute ? this.route : null;
  }

  private movedM(): number {
    return this.onRoute ? Math.abs(this.alongM - this.startAlongM) : 0;
  }

  /** 出発地点がルートのどこに当たるかを求める。 */
  private locateStart(): void {
    this.onRoute = false;
    this.startAlongM = 0;
    if (this.route) {
      const anchor = this.route.anchorFor(this.start);
      // ルートから離れすぎている地点は「乗っていない」扱いにして動かさない
      this.onRoute = anchor.offsetM <= TAP_SNAP_M;
      if (this.onRoute) this.startAlongM = anchor.alongM;
    }
    this.alongM = this.startAlongM;
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------
  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      if (this.dragPointerId !== null) return;
      this.dragPointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dragTravel = 0;
      // 画面外まで引っ張っても追従させる（取れなくても見回しは動く）
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 何もしない
      }
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragPointerId !== e.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dragTravel += Math.abs(dx) + Math.abs(dy);
      // 右にドラッグすると景色が右に流れる（＝視線は左へ）
      this.look(-dx * YAW_PER_PX, -dy * DOWN_PER_PX);
    });
    const end = (e: PointerEvent): void => {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragPointerId = null;
      canvas.style.cursor = 'grab';
      if (this.dragTravel < TAP_SLOP_PX) this.tap(e);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /** タップした地形の位置を拾い、ルートの上ならそこへ移動する。 */
  private tap(e: PointerEvent): void {
    const rect = this.map.getCanvas().getBoundingClientRect();
    const lngLat = this.map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
    this.walkToPoint({ lat: lngLat.lat, lon: lngLat.lng });
  }

  private bindKeys(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('keydown', (e) => {
      const turn = e.shiftKey ? 15 : 5;
      const step = e.shiftKey ? LONG_STEP_M : STEP_M;
      if (e.key === 'ArrowLeft') this.look(-turn, 0);
      else if (e.key === 'ArrowRight') this.look(turn, 0);
      else if (e.key === 'ArrowUp') this.walk(step);
      else if (e.key === 'ArrowDown') this.walk(-step);
      else if (e.key === 'PageUp') this.look(0, -3);
      else if (e.key === 'PageDown') this.look(0, 3);
      else if (e.key === 'Home') this.returnToStart();
      else return;
      e.preventDefault();
    });
  }

  // -------------------------------------------------------------------------
  // 地形の上に描くもの
  // -------------------------------------------------------------------------
  /** トラックを差し替える（山が変わったとき）。 */
  setTrack(track: TrackFeature | null): void {
    this.trackData = track;
    this.route = RoutePath.from(track);
    this.locateStart();
    if (this.ready) {
      this.renderRoute();
      this.updateStartMarker();
      this.restartSettle();
      this.apply();
    }
    this.onWalk?.(this.walkState());
  }

  /**
   * ルート全体を地形の上に描く。
   *
   * 線は地形に貼り付けて描かれる（貼り付け先の解像度は標高タイルに縛られるので、
   * 近くで見ると登山道くらいの幅に見える）。尾根の裏に回った部分は地形に隠れて見えない。
   */
  private renderRoute(): void {
    const track = this.trackData;
    if (!track) {
      for (const id of [LAYER_ROUTE, LAYER_ROUTE_HALO]) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      }
      if (this.map.getSource(SOURCE_ROUTE)) this.map.removeSource(SOURCE_ROUTE);
      return;
    }
    const data = track as unknown as GeoJSON.Feature;
    const source = this.map.getSource(SOURCE_ROUTE);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(data);
      return;
    }
    this.map.addSource(SOURCE_ROUTE, { type: 'geojson', data });
    // 線は地形に焼き付けて描かれ、その解像度は標高タイル（z14＝約5m）に縛られる。
    // つまり線幅1は地面の約5m。登山道らしく見える太さになるまで絞り、
    // 遠くを見ているとき（ズームが下がるとき）は見失わないよう太くする
    const width = (scale: number): maplibregl.ExpressionSpecification => [
      'interpolate',
      ['linear'],
      ['zoom'],
      13,
      2.5 * scale,
      17,
      0.9 * scale,
      21,
      0.35 * scale,
    ];
    this.map.addLayer({
      id: LAYER_ROUTE_HALO,
      type: 'line',
      source: SOURCE_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      // 下地が空中写真（緑や岩の柄）なので、白のハローを敷かないと朱線が埋もれる
      paint: { 'line-color': '#ffffff', 'line-width': width(1.8), 'line-opacity': 0.55 },
    });
    this.map.addLayer({
      id: LAYER_ROUTE,
      type: 'line',
      source: SOURCE_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#c2410c', 'line-width': width(1) },
    });
  }

  /**
   * 出題地点の印。
   *
   * 地面には輪を描き、離れたら遠くからでも分かるようにピンを立てる。
   * **答えの座標そのものだが、プレイヤーは自分がそこから歩き出したことを知っている**
   * ので隠す意味は無い（ストリートビューで開始地点が分かるのと同じ）。
   * 足元に立っている間はピンが視界を塞ぐだけなので出さない。
   */
  private addStartMarker(): void {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [this.start.lon, this.start.lat] },
    };
    const source = this.map.getSource(SOURCE_START);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(feature);
      this.updateStartMarker();
      return;
    }
    this.map.addSource(SOURCE_START, { type: 'geojson', data: feature });
    this.map.addLayer({
      id: LAYER_START_RING,
      type: 'circle',
      source: SOURCE_START,
      paint: {
        'circle-radius': 16,
        'circle-color': '#e8a33d',
        'circle-opacity': 0.18,
        'circle-stroke-color': '#e8a33d',
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.7,
        'circle-pitch-alignment': 'map',
      },
    });
    this.map.addLayer({
      id: LAYER_START,
      type: 'circle',
      source: SOURCE_START,
      paint: {
        'circle-radius': 5,
        'circle-color': '#e8a33d',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-pitch-alignment': 'map',
      },
    });
    this.updateStartMarker();
  }

  /** 遠くからでも見える出題地点のピン。地形に沿って置かれ、尾根の裏では薄くなる。 */
  private ensureStartPin(): void {
    if (this.startPin) {
      this.startPin.setLngLat([this.start.lon, this.start.lat]);
      return;
    }
    const element = document.createElement('div');
    element.className = 'terrain-pin';
    const dot = document.createElement('span');
    dot.className = 'terrain-pin__dot';
    const label = document.createElement('span');
    label.className = 'terrain-pin__label';
    label.textContent = '出題地点';
    element.append(label, dot);
    this.startPin = new maplibregl.Marker({ element, anchor: 'bottom' })
      .setLngLat([this.start.lon, this.start.lat])
      .addTo(this.map);
  }

  private updateStartMarker(): void {
    this.ensureStartPin();
    // 立っている場所からの直線距離で出し入れする（足元では邪魔になるだけ）
    const away = distanceMeters(this.eye(), this.start);
    const pin = this.startPin?.getElement();
    if (pin) pin.style.display = away >= START_PIN_AFTER_M ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // 画面表示
  // -------------------------------------------------------------------------
  /** 短い知らせを出す（ルートの端に来た、など）。 */
  private flash(message: string): void {
    this.note = message;
    this.renderHud();
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note = null;
      this.noteTimer = null;
      this.renderHud();
    }, 2200);
  }

  /** 立っている地面の標高 [m]（誇張を戻した実標高）。 */
  private standingElevationM(): number {
    if (!this.ready) return this.groundElevationM;
    return this.elevationAt(this.eye()) / TERRAIN_EXAGGERATION;
  }

  private renderHud(): void {
    const moved = this.movedM();
    const elevation = this.standingElevationM();
    const parts = [
      `<span class="terrain-hud__here">${moved >= 1 ? '今ここ' : 'この地点'}</span>`,
      `<span class="terrain-hud__facing num">${Math.round(this.bearing)}°</span>`,
      `<span class="terrain-hud__dir">${compassLabel(this.bearing)}向き</span>`,
    ];
    if (elevation > 0) {
      parts.push(`<span class="terrain-hud__ele num">標高 ${Math.round(elevation)} m</span>`);
    }
    if (moved >= 1) {
      parts.push(
        `<span class="terrain-hud__moved num">出発地点から ${Math.round(moved)} m</span>`,
      );
    }
    if (this.note) parts.push(`<span class="terrain-hud__note">${this.note}</span>`);
    this.hud.innerHTML = parts.join('\n');
  }

  /** 操作の説明。凡例として画面に出す。 */
  static routeLegend(): string {
    return '朱線は歩いたルート。ドラッグで見回し、タップで移動';
  }

  // -------------------------------------------------------------------------
  // 出し入れ
  // -------------------------------------------------------------------------
  /** 次の問題へ。立ち位置と初期の向きを移す。 */
  moveTo(center: LatLng, headingDeg: number, groundElevationM?: number): void {
    this.start = center;
    this.bearing = headingDeg;
    this.downDeg = MIN_DOWN_DEG;
    this.groundElevationM = groundElevationM ?? 0;
    this.locateStart();
    if (this.ready) {
      this.addStartMarker();
      this.renderRoute();
      this.restartSettle();
    }
    this.onWalk?.(this.walkState());
    this.apply();
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.cancelWalkAnimation();
    this.startPin?.remove();
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.hud.remove();
    this.map.remove();
  }
}
