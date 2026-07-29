/**
 * 距離リング — このプロジェクトのシグネチャ（DESIGN.md）。
 *
 * 回答後、正解地点を中心に等高線と同じ細い茶の同心円を描く。
 * GeoGuessr は直線と距離しか出さないが、山では等高線こそが土地勘の言語であり、
 * 「500mリングの中には入った」という理解のしかたがこの題材でだけ意味を持つ。
 */
import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../scoring';

/** 描くリングの半径 [m]。中心から外へ。 */
export const RING_RADII_M = [100, 250, 500, 1000, 2000, 5000] as const;

const SOURCE_RINGS = 'yg-rings';
const SOURCE_LINE = 'yg-answer-line';
const LAYER_RINGS = 'yg-rings-line';
const LAYER_LINE = 'yg-answer-line-line';

const CONTOUR = '#a9793f';

/** リングのラベルはHTMLマーカーで描く。
 *  MapLibre の symbol レイヤは glyphs サーバを要求するため外部依存が増えるうえ、
 *  自前の等幅フォント（DESIGN.md の署名）を使えない。 */
const labelMarkers = new WeakMap<MapLibreMap, Marker[]>();

type Feature = GeoJSON.Feature<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>;

/** 中心から半径 radiusM の円を、測地的におおよそ正しい多角形として作る。 */
export function circlePolygon(center: LatLng, radiusM: number, steps = 96): Feature {
  const coords: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos(latRad);
  for (let i = 0; i <= steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    coords.push([
      center.lon + (radiusM * Math.sin(angle)) / mPerDegLon,
      center.lat + (radiusM * Math.cos(angle)) / mPerDegLat,
    ]);
  }
  return {
    type: 'Feature',
    properties: { radius_m: radiusM, label: formatRadius(radiusM) },
    geometry: { type: 'Polygon', coordinates: [coords] },
  };
}

export function formatRadius(radiusM: number): string {
  return radiusM >= 1000 ? `${radiusM / 1000}km` : `${radiusM}m`;
}

/**
 * 表示するリングを選ぶ。外した距離を1つ包み込むところまでを描く。
 * 全部描くと地図が線だらけになるので、意味のある範囲に絞る。
 */
export function visibleRadii(distanceM: number): number[] {
  const radii = RING_RADII_M.filter((r) => r <= Math.max(distanceM * 1.6, 250));
  const next = RING_RADII_M.find((r) => r > distanceM);
  if (next !== undefined && !radii.includes(next)) radii.push(next);
  return radii.length > 0 ? radii : [RING_RADII_M[0]];
}

function ringCollection(center: LatLng, distanceM: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: visibleRadii(distanceM).map((r) => circlePolygon(center, r)),
  };
}

function lineCollection(actual: LatLng, guess: LatLng): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [guess.lon, guess.lat],
            [actual.lon, actual.lat],
          ],
        },
      },
    ],
  };
}

/** 正解地点を中心にリングと、推測地点を結ぶ線を描く。 */
export function showRings(
  map: MapLibreMap,
  actual: LatLng,
  guess: LatLng,
  distanceM: number,
): void {
  const rings = ringCollection(actual, distanceM);
  const line = lineCollection(actual, guess);

  const ringSource = map.getSource(SOURCE_RINGS);
  if (ringSource && 'setData' in ringSource) {
    (ringSource as GeoJSONSource).setData(rings);
  } else {
    map.addSource(SOURCE_RINGS, { type: 'geojson', data: rings });
    map.addLayer({
      id: LAYER_RINGS,
      type: 'line',
      source: SOURCE_RINGS,
      paint: {
        'line-color': CONTOUR,
        'line-width': ['case', ['>=', ['get', 'radius_m'], 1000], 1.6, 1],
        'line-opacity': 0.9,
      },
    });
  }
  renderLabels(map, actual, guess, distanceM);

  const lineSource = map.getSource(SOURCE_LINE);
  if (lineSource && 'setData' in lineSource) {
    (lineSource as GeoJSONSource).setData(line);
  } else {
    map.addSource(SOURCE_LINE, { type: 'geojson', data: line });
    map.addLayer({
      id: LAYER_LINE,
      type: 'line',
      source: SOURCE_LINE,
      paint: {
        'line-color': '#10161f',
        'line-width': 2,
        'line-dasharray': [2, 1.5],
      },
    });
  }
}

/**
 * ラベルは**推測地点の方向**のリング上に置く。
 * こうすると「自分が越えてきたリング」が一列に並んで読め、
 * 地図を合わせた範囲から外に出ていかない。
 */
function renderLabels(
  map: MapLibreMap,
  center: LatLng,
  guess: LatLng,
  distanceM: number,
): void {
  clearLabels(map);
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((center.lat * Math.PI) / 180);
  const dx = (guess.lon - center.lon) * mPerDegLon;
  const dy = (guess.lat - center.lat) * mPerDegLat;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;

  const markers = visibleRadii(distanceM).map((radius) => {
    const node = document.createElement('span');
    node.className = 'yg-ring-label';
    node.textContent = formatRadius(radius);
    node.setAttribute('aria-hidden', 'true');
    return new Marker({ element: node })
      .setLngLat([
        center.lon + (ux * radius) / mPerDegLon,
        center.lat + (uy * radius) / mPerDegLat,
      ])
      .addTo(map);
  });
  labelMarkers.set(map, markers);
}

function clearLabels(map: MapLibreMap): void {
  for (const marker of labelMarkers.get(map) ?? []) marker.remove();
  labelMarkers.delete(map);
}

/** 次の問題に移るときにリングと線を消す。 */
export function clearRings(map: MapLibreMap): void {
  clearLabels(map);
  for (const id of [LAYER_RINGS, LAYER_LINE]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SOURCE_RINGS, SOURCE_LINE]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}
