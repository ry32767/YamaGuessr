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
import type { Feature } from 'geojson';
import {
  distanceMeters,
  hikingMinutes,
  walkSeconds,
  type LatLng,
  type WalkEffort,
} from '../scoring';
import type { TrackFeature } from '../types';
import {
  DEFAULT_DOWN_DEG,
  EYE_HEIGHT_M,
  FOV_DEG,
  MAX_DOWN_DEG,
  MIN_DOWN_DEG,
  aimTarget,
  clampDown,
} from './eye';
import { circlePolygon } from './rings';
import { RoutePath, angleDiffDeg, newGroundInterval } from './route';
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
/** 出題地点の地面に描く輪の半径 [m] */
const START_RING_M = 8;
/** 歩いた登り下りを拾う刻み [m]。細かすぎると標高タイルの粗さを拾ってしまう */
const EFFORT_SAMPLE_M = 20;
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
 * ズームの範囲。ズームは「狙い先までの距離」から決まる（[eye.ts](eye.ts)）ので、
 * 直接いじる操作は無い。狙い先は40〜250mに収まるので実際は18〜21程度にしかならず、
 * ここは「万一おかしな値が来ても破綻させない」ための枠。
 */
const MIN_ZOOM = 13;
const MAX_ZOOM = 23;

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
  /** 出発地点からルート上を移動した距離 [m]（＝いまどれだけ離れているか） */
  movedM: number;
  /** 歩けるか（ルートが登録されているか） */
  canWalk: boolean;
  /** この問題で歩いた量（往復ぶんも足す） */
  effort: WalkEffort;
  /** その道のりを実際に歩いたときの推定所要時間 [分] */
  minutes: number;
  /** 同じものを秒で（タイマーに足す値） */
  seconds: number;
}

/** 歩き出しと止まりを柔らかくする（等速だと機械が動いたように見える）。 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** 視線の上下を日本語にする。水平がどこかが分からないと地形を読み違える。 */
export function tiltLabel(downDeg: number): string {
  if (downDeg <= -3) return `見上げ ${Math.round(-downDeg)}°`;
  if (downDeg >= 3) return `見下ろし ${Math.round(downDeg)}°`;
  return '水平';
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
  /** この問題で歩いた量（時間に換算してタイマーに乗せる） */
  private walked: WalkEffort = { distanceM: 0, ascentM: 0, descentM: 0 };
  /** この問題でいちばん先まで行った位置。ここまでは「見た道」として時間を取らない */
  private exploredM = 0;
  private bearing: number;
  private downDeg = DEFAULT_DOWN_DEG;
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
      zoom: 19,
      pitch: 90 - DEFAULT_DOWN_DEG,
      bearing: options.headingDeg,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // 既定の上限は60度。水平（90）も見上げ（90超）も使うので、その上まで開ける
      maxPitch: 90 - MIN_DOWN_DEG,
      minPitch: Math.max(0, 90 - MAX_DOWN_DEG),
      // **中心を地面に貼り付けない。** 視線上の一点（空中）を中心にするための肝
      // （これが false でないと、見上げ＝pitch>90 のときカメラが地下に潜る）
      centerClampedToGround: false,
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
    // 既定（36.87度）は望遠すぎて、周りの尾根が視界に入らない（[eye.ts](eye.ts)）
    this.map.setVerticalFieldOfView(FOV_DEG);
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
        '上下のドラッグ（PageUp/PageDownキー）で見上げ・見下ろしができます。' +
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

  /**
   * 立っている地面の標高 [m]（誇張後）。
   *
   * **MapLibre自身の読み（描画ズームでの標高）より低く見積もらない。**
   * MapLibreには「カメラが地形に潜っていたら持ち上げる」保護があり、そこでは
   * *描画ズーム*での標高が使われる。こちらが固定ズームで読んだ値のほうが低いと、
   * 潜っていると誤判定されてカメラを上げられ、**見下ろす画（俯瞰）に化ける**。
   * 高いほうを採って、そもそも保護が働かないようにしておく。
   */
  private groundUnderEye(): number {
    const eye = this.eye();
    return Math.max(this.elevationAt(eye), this.elevationAt(eye, Math.floor(this.map.getZoom())));
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
   * **視線上の一点をそのまま画面の中心にする。** MapLibre v5 の
   * `centerClampedToGround: false` により中心は空中でよく、その標高を視線に合わせておけば
   * カメラは必ず視線の延長——つまり目の位置——に来る。見下ろし角は操作した角度そのまま、
   * ズームは狙い先までの距離だけで決まる（[eye.ts](eye.ts)）。
   */
  private apply(): void {
    this.renderHud();
    if (!this.ready) return;
    const eye = this.eye();
    const eyeAltitudeM = this.groundUnderEye() + EYE_HEIGHT_M * TERRAIN_EXAGGERATION;
    const aim = aimTarget({
      eye,
      eyeAltitudeM,
      bearingDeg: this.bearing,
      downDeg: this.downDeg,
      elevationAt: (p) => this.elevationAt(p),
    });
    const options = this.map.calculateCameraOptionsFromTo(
      new LngLat(eye.lon, eye.lat),
      eyeAltitudeM,
      new LngLat(aim.target.lon, aim.target.lat),
      aim.altitudeM,
    );
    if (this.sameAsCurrent(options)) return;
    this.map.jumpTo(options);
    // MapLibreには「カメラが地形に潜ったら持ち上げる」保護がある。誤検知で視点を
    // 書き換えられたら次のフレームで解き直す（`groundUnderEye` で予防はしてある）。
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
      Math.abs((options.elevation ?? 0) - this.map.getCenterElevation()) < 0.05 &&
      Math.abs(angleDiffDeg(options.bearing ?? 0, this.map.getBearing())) < 0.05 &&
      Math.abs(center.lng - current.lng) < 1e-7 &&
      Math.abs(center.lat - current.lat) < 1e-7
    );
  }

  private look(deltaYaw: number, deltaDown: number): void {
    this.bearing = (((this.bearing + deltaYaw) % 360) + 360) % 360;
    this.downDeg = clampDown(this.downDeg + deltaDown);
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
    // 歩いた量は**動く前**に足す（アニメーションの途中で回答されても勘定が合うように）
    this.addEffort(route, from, to);

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
    return {
      movedM: this.movedM(),
      canWalk: this.walkableRoute() !== null,
      effort: this.effort(),
      minutes: hikingMinutes(this.effort()),
      seconds: walkSeconds(this.effort()),
    };
  }

  /**
   * この問題で歩いた量（道のりと累積の登り下り）。
   *
   * **往復しても足し算**（`movedM` の「出発地点からの距離」とは別物）。
   * 実際に山を歩けば戻り道にも時間がかかるので、歩いたぶんだけ数える。
   */
  effort(): WalkEffort {
    return { ...this.walked };
  }

  /**
   * `from` から `to` までルートの上を歩いたぶんを足す。
   *
   * **数えるのは「まだ見ていない区間」だけ**（[route.ts](route.ts) `newGroundInterval`）。
   * 出題地点より手前は**ここへ来るまでに歩いた道**だし、一度先まで行って戻る道も
   * さっき見たばかりなので、覚えている前提で時間を取らない。
   *
   * 登り下りは**地形の標高を刻んで拾う**（トラックは緯度経度だけで標高を持たないため）。
   * 誇張を戻した実標高で数えるので、そのまま「実際に歩いたときの所要時間」に使える。
   */
  private addEffort(route: RoutePath, from: number, to: number): void {
    const charged = newGroundInterval(from, to, this.exploredM);
    this.exploredM = Math.max(this.exploredM, from, to);
    if (!charged) return;
    const distance = charged.to - charged.from;
    this.walked.distanceM += distance;
    const steps = Math.max(1, Math.ceil(distance / EFFORT_SAMPLE_M));
    let previous = this.groundHeightM(route.positionAt(charged.from));
    for (let i = 1; i <= steps; i += 1) {
      const along = charged.from + (distance * i) / steps;
      const height = this.groundHeightM(route.positionAt(along));
      const delta = height - previous;
      if (delta > 0) this.walked.ascentM += delta;
      else this.walked.descentM -= delta;
      previous = height;
    }
  }

  /** 実標高 [m]（誇張を戻したもの）。 */
  private groundHeightM(p: LatLng): number {
    return this.elevationAt(p) / TERRAIN_EXAGGERATION;
  }

  /** 歩けるルート。トラックが無い／出発地点がルートから離れているときは null。 */
  private walkableRoute(): RoutePath | null {
    return this.onRoute ? this.route : null;
  }

  private movedM(): number {
    return this.onRoute ? Math.abs(this.alongM - this.startAlongM) : 0;
  }

  /** 出発地点がルートのどこに当たるかを求める。歩いた量もここで0に戻す。 */
  private locateStart(): void {
    this.walked = { distanceM: 0, ascentM: 0, descentM: 0 };
    this.exploredM = 0;
    this.onRoute = false;
    this.startAlongM = 0;
    if (this.route) {
      const anchor = this.route.anchorFor(this.start);
      // ルートから離れすぎている地点は「乗っていない」扱いにして動かさない
      this.onRoute = anchor.offsetM <= TAP_SNAP_M;
      if (this.onRoute) this.startAlongM = anchor.alongM;
    }
    this.alongM = this.startAlongM;
    // 出発地点までの道はもう歩いてきた道。ここより手前は無料にする
    this.exploredM = this.startAlongM;
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
    const data = track as unknown as Feature;
    const source = this.map.getSource(SOURCE_ROUTE);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(data);
      return;
    }
    this.map.addSource(SOURCE_ROUTE, { type: 'geojson', data });
    // 線は地形に焼き付けて描かれるので、画面上の見た目の太さはズーム（＝見ている先までの
    // 距離）で変わる。**細すぎると空中写真の地面の柄に紛れて追えなくなる**ので、
    // 登山道より少し太いくらい——遠景でも線として追える太さ——に取る。
    const width = (scale: number): maplibregl.ExpressionSpecification => [
      'interpolate',
      ['linear'],
      ['zoom'],
      13,
      3.6 * scale,
      17,
      2.4 * scale,
      20,
      1.8 * scale,
      23,
      1.4 * scale,
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
    // **地面の輪は fill / line で描く。** circle レイヤは地形に焼き付けられず
    // 手前の尾根を無視して上に描かれるので、**別の谷にいる出題地点まで透けて見える**。
    // fill / line は地形に貼り付いて描かれるため、隠れるべきものは隠れる。
    const data: Feature = circlePolygon(this.start, START_RING_M, 48);
    const source = this.map.getSource(SOURCE_START);
    if (source && 'setData' in source) {
      (source as maplibregl.GeoJSONSource).setData(data);
      this.updateStartMarker();
      return;
    }
    this.map.addSource(SOURCE_START, { type: 'geojson', data });
    this.map.addLayer({
      id: LAYER_START_RING,
      type: 'fill',
      source: SOURCE_START,
      paint: { 'fill-color': '#e8a33d', 'fill-opacity': 0.3 },
    });
    this.map.addLayer({
      id: LAYER_START,
      type: 'line',
      source: SOURCE_START,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.9 },
    });
    this.updateStartMarker();
  }

  /**
   * 出題地点のピン。**いま出題している1点だけ**を立てる。
   *
   * `opacityWhenCovered: 0` で、**尾根の裏に回った出題地点は完全に消える**
   * （MapLibreの既定は0.2で、地形越しに透けて見えてしまう）。
   * 作る前に古いピンを掃除しているのは、前の問題のピンが残らないことを
   * この1か所で保証するため（消し忘れると「出題地点」がいくつも見える）。
   */
  private ensureStartPin(): void {
    if (this.startPin) {
      this.startPin.setLngLat([this.start.lon, this.start.lat]);
      return;
    }
    for (const stray of this.map.getCanvasContainer().querySelectorAll('.terrain-pin')) {
      stray.remove();
    }
    const element = document.createElement('div');
    element.className = 'terrain-pin';
    const dot = document.createElement('span');
    dot.className = 'terrain-pin__dot';
    const label = document.createElement('span');
    label.className = 'terrain-pin__label';
    label.textContent = '出題地点';
    element.append(label, dot);
    this.startPin = new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0' })
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
      // 見上げ／見下ろしが自由に振れるようになったので、いまどちらを向いているかを出す
      `<span class="terrain-hud__dir">${tiltLabel(this.downDeg)}</span>`,
    ];
    if (elevation > 0) {
      parts.push(`<span class="terrain-hud__ele num">標高 ${Math.round(elevation)} m</span>`);
    }
    if (moved >= 1) {
      parts.push(
        `<span class="terrain-hud__moved num">出発地点から ${Math.round(moved)} m</span>`,
      );
    }
    // 歩くと持ち時間を使う。**押す前に判断できるよう、いくら使ったかを常に出す**
    const walked = this.walked.distanceM;
    if (walked >= 1) {
      const minutes = Math.max(1, Math.round(hikingMinutes(this.walked)));
      parts.push(
        `<span class="terrain-hud__cost num">歩き ${Math.round(walked)} m` +
          `／時間 +${minutes}分</span>`,
      );
    }
    if (this.note) parts.push(`<span class="terrain-hud__note">${this.note}</span>`);
    this.hud.innerHTML = parts.join('\n');
  }

  /** 操作の説明。凡例として画面に出す。 */
  static routeLegend(): string {
    return '朱線は歩いたルート。ドラッグで見回し（上下で見上げ）、タップで移動';
  }

  // -------------------------------------------------------------------------
  // 出し入れ
  // -------------------------------------------------------------------------
  /** 次の問題へ。立ち位置と初期の向きを移す。 */
  moveTo(center: LatLng, headingDeg: number, groundElevationM?: number): void {
    this.start = center;
    this.bearing = headingDeg;
    this.downDeg = DEFAULT_DOWN_DEG;
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
    this.startPin = null;
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.hud.remove();
    this.map.remove();
  }
}
