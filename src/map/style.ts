/**
 * 国土地理院タイルを MapLibre で使うためのスタイル定義。
 *
 * 出典表示は利用規約上の必須事項（docs/operations.md）。attribution は必ず載せ、
 * 地図・3Dビューの両方で AttributionControl を表示する。
 */
import maplibregl, { type StyleSpecification } from 'maplibre-gl';

export const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

const GSI_TILES = {
  /** 地形図（等高線・地名あり）。回答用の2D地図に使う */
  std: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  /** 淡色地図 */
  pale: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
} as const;

/** 標高タイル（PNG）。DEM10B相当、z=14まで */
const GSI_DEM_PNG = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const DEM_MAX_ZOOM = 14;

/** 独自プロトコル名。addProtocol で terrain-RGB に変換して返す */
const GSI_DEM_PROTOCOL = 'gsidem';

export type BaseMapKind = keyof typeof GSI_TILES;

/** 回答用の2D地形図スタイル（機能F・機能Gの回答面で共通）。 */
export function baseMapStyle(kind: BaseMapKind = 'std'): StyleSpecification {
  return {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: [GSI_TILES[kind]],
        tileSize: 256,
        maxzoom: 18,
        attribution: GSI_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#10161f' } },
      { id: 'gsi', type: 'raster', source: 'gsi' },
    ],
  };
}

/**
 * モード②の3D地形スタイル。
 *
 * **地形図タイルをテクスチャとして貼らない。** 地形図には山名・三角点・注記が
 * 焼き込まれており、答えが画面に出てしまう（docs/spec.md 設計判断表）。
 * 描くのは陰影起伏（hillshade）と単色の地色だけ。
 */
export function terrainStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      dem: {
        type: 'raster-dem',
        tiles: [`${GSI_DEM_PROTOCOL}://${GSI_DEM_PNG}`],
        tileSize: 256,
        maxzoom: DEM_MAX_ZOOM,
        attribution: GSI_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#233040' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          // 暗くしすぎると尾根と谷の区別がつかない。実データで見て調整した値。
          'hillshade-shadow-color': '#31414f',
          'hillshade-highlight-color': '#eef3f7',
          'hillshade-accent-color': '#7d8fa0',
          'hillshade-exaggeration': 0.55,
        },
      },
    ],
    terrain: { source: 'dem', exaggeration: 1.2 },
    sky: {
      'sky-color': '#5a7ea8',
      'horizon-color': '#9db4c8',
      'fog-color': '#8fa3b5',
      'fog-ground-blend': 0.6,
      'horizon-fog-blend': 0.5,
    },
  };
}

// ---------------------------------------------------------------------------
// 地理院の標高タイル（独自エンコード）→ MapLibre が読める terrain-RGB に変換
// ---------------------------------------------------------------------------
let protocolRegistered = false;

/**
 * `gsidem://` プロトコルを登録する。
 *
 * 地理院の dem_png は `x = 2^16 R + 2^8 G + B`、`x < 2^23` なら標高 `x/100` m、
 * それ以上なら `(x - 2^24)/100` m、`x = 2^23`（RGB=128,128,128）は欠測、という
 * 独自エンコード。MapLibre は Mapbox 形式の terrain-RGB しか解釈しないため、
 * ここで詰め替える。外部ライブラリを足さずに済ませるための実装。
 */
export function registerGsiDemProtocol(): void {
  if (protocolRegistered || typeof window === 'undefined') return;
  protocolRegistered = true;

  maplibregl.addProtocol(GSI_DEM_PROTOCOL, async (params) => {
    const url = params.url.replace(`${GSI_DEM_PROTOCOL}://`, '');
    const res = await fetch(url);
    if (!res.ok) {
      // 整備範囲外のタイルは 404。透明タイルを返して地形を平坦に扱う
      if (res.status === 404) return { data: transparentTile() };
      throw new Error(`標高タイルを取得できませんでした: ${res.status}`);
    }
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    return { data: toTerrainRgb(bitmap) };
  });
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toTerrainRgb(bitmap: ImageBitmap): ArrayBuffer {
  const { width, height } = bitmap;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('canvas 2d コンテキストを作れませんでした');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] ?? 0;
    const g = px[i + 1] ?? 0;
    const b = px[i + 2] ?? 0;
    const x = r * 65536 + g * 256 + b;
    // 2^23 は欠測。海面(0m)として扱う
    const elevation = x === 8388608 ? 0 : (x < 8388608 ? x : x - 16777216) / 100;
    // Mapbox terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1
    const v = Math.round((elevation + 10000) * 10);
    px[i] = (v >> 16) & 0xff;
    px[i + 1] = (v >> 8) & 0xff;
    px[i + 2] = v & 0xff;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return encodePng(canvas);
}

function encodePng(canvas: OffscreenCanvas | HTMLCanvasElement): ArrayBuffer {
  // 同期的に ArrayBuffer が必要なので dataURL 経由で取り出す
  const dataUrl =
    canvas instanceof HTMLCanvasElement
      ? canvas.toDataURL('image/png')
      : offscreenToDataUrl(canvas);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function offscreenToDataUrl(canvas: OffscreenCanvas): string {
  // OffscreenCanvas には toDataURL が無いので、一度 HTMLCanvasElement に写す
  const fallback = document.createElement('canvas');
  fallback.width = canvas.width;
  fallback.height = canvas.height;
  const ctx = fallback.getContext('2d');
  if (!ctx) throw new Error('canvas 2d コンテキストを作れませんでした');
  ctx.drawImage(canvas as unknown as CanvasImageSource, 0, 0);
  return fallback.toDataURL('image/png');
}

let cachedTransparent: ArrayBuffer | null = null;

function transparentTile(): ArrayBuffer {
  if (cachedTransparent) return cachedTransparent;
  const canvas = makeCanvas(256, 256);
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('canvas 2d コンテキストを作れませんでした');
  // 標高 0m を表す terrain-RGB
  const v = Math.round(10000 * 10);
  ctx.fillStyle = `rgb(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff})`;
  ctx.fillRect(0, 0, 256, 256);
  cachedTransparent = encodePng(canvas);
  return cachedTransparent;
}
