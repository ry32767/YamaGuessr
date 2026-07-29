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

/** 3D地形の起伏の強調度。`map.setTerrain` に渡す */
export const TERRAIN_EXAGGERATION = 1.2;

/** 3D地形の標高ソースID */
export const TERRAIN_SOURCE = 'dem';

/**
 * モード②の3D地形スタイル。
 *
 * **地形図タイルをテクスチャとして貼らない。** 地形図には山名・三角点・注記が
 * 焼き込まれており、答えが画面に出てしまう（docs/spec.md 設計判断表）。
 * 描くのは陰影起伏（hillshade）と単色の地色だけ。
 *
 * `terrain` はスタイルに書かず、読み込み完了後に `map.setTerrain` で入れる。
 * スタイル定義に混ぜると、読み込みの途中でカメラを動かしたときに
 * 地形が有効にならないことがあったため。
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
      // 整備範囲外のタイルは 404。標高0mのタイルを返して平坦に扱う
      if (res.status === 404) return { data: await flatTile() };
      throw new Error(`標高タイルを取得できませんでした: ${res.status}`);
    }
    const blob = await res.blob();
    // 標高は画素値そのものなので、色変換やアルファの事前乗算が入ると値が壊れる。
    // 明示的に切っておかないと、地形が階段状・縞状に破綻する。
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    return { data: await toTerrainRgb(bitmap) };
  });
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function toTerrainRgb(bitmap: ImageBitmap): Promise<ArrayBuffer> {
  const { width, height } = bitmap;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
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

/**
 * canvas を PNG のバイト列にする。
 *
 * **canvas から canvas へ描き写してはいけない。** 標高は画素値そのものなので、
 * drawImage を挟むと色管理で値がずれ、地形が壊れる。
 * `convertToBlob` / `toBlob` で直接取り出す。
 */
function encodePng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' }).then((blob) => blob.arrayBuffer());
  }
  const element = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => {
      if (!blob) {
        reject(new Error('標高タイルをPNGに変換できませんでした'));
        return;
      }
      resolve(blob.arrayBuffer());
    }, 'image/png');
  });
}

let cachedFlat: ArrayBuffer | null = null;

/** 標高0mのタイル。整備範囲外（404）で使う。 */
async function flatTile(): Promise<ArrayBuffer> {
  if (cachedFlat) return cachedFlat;
  const canvas = makeCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('canvas 2d コンテキストを作れませんでした');
  const v = Math.round(10000 * 10); // 標高 0m を表す terrain-RGB
  const image = ctx.createImageData(256, 256);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = (v >> 16) & 0xff;
    image.data[i + 1] = (v >> 8) & 0xff;
    image.data[i + 2] = v & 0xff;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  cachedFlat = await encodePng(canvas);
  return cachedFlat;
}
