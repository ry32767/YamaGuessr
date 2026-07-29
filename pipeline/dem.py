"""国土地理院の標高タイル（DEM）を読むためのモジュール。

タイルは `https://cyberjapandata.gsi.go.jp/xyz/{source}/{z}/{x}/{y}.txt` の
256x256 のCSV（単位: m、欠測は "e"）。**必ずローカルにキャッシュし、同じタイルを
二度取りに行かない**（地理院タイルは大量アクセスの自粛が要請されている。
[docs/operations.md](../docs/operations.md) 参照）。

前処理でしか使わない。フロントエンドはタイルを直接MapLibreに読ませる。
"""
from __future__ import annotations

import math
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator, NamedTuple, Optional

from geo import LatLon

#: 既定のキャッシュ先（.gitignore 対象）
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / "data" / "dem_cache"

#: 使う標高タイル。(source, zoom, 説明) を優先順に並べる
DEM_SOURCES: tuple[tuple[str, int, str], ...] = (
    ("dem", 14, "DEM10B（10mメッシュ・全国）"),
    ("dem5a", 15, "DEM5A（5mメッシュ・レーザ測量、整備範囲のみ）"),
)

TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/{source}/{z}/{x}/{y}.txt"
TILE_PIXELS = 256
USER_AGENT = "YamaGuessr-pipeline/0.1 (local preprocessing)"


class DemError(RuntimeError):
    """DEM の取得・解釈に失敗した。"""


class TileKey(NamedTuple):
    source: str
    z: int
    x: int
    y: int


def deg_to_tile_xy(lat: float, lon: float, z: int) -> tuple[float, float]:
    """緯度経度を、タイル座標（小数部が画素位置）に変換する（Webメルカトル）。"""
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    r = math.radians(lat)
    y = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    return x, y


class DemReader:
    """標高タイルをキャッシュしつつ引く。"""

    def __init__(self, source: str = "dem", zoom: Optional[int] = None,
                 cache_dir: Path | str = DEFAULT_CACHE_DIR,
                 offline: bool = False) -> None:
        known = {s: (z, desc) for s, z, desc in DEM_SOURCES}
        if source not in known:
            raise DemError(f"未知の標高タイル: {source}（{'/'.join(known)} のいずれか）")
        self.source = source
        self.zoom = zoom if zoom is not None else known[source][0]
        self.cache_dir = Path(cache_dir)
        self.offline = offline
        self._tiles: dict[TileKey, list[list[Optional[float]]]] = {}
        self.fetch_count = 0
        self.cache_hit_count = 0

    # -- タイル取得 --------------------------------------------------------
    def _cache_path(self, key: TileKey) -> Path:
        return self.cache_dir / key.source / str(key.z) / str(key.x) / f"{key.y}.txt"

    def _load_tile(self, key: TileKey) -> list[list[Optional[float]]]:
        cached = self._tiles.get(key)
        if cached is not None:
            return cached

        path = self._cache_path(key)
        if path.exists():
            text = path.read_text(encoding="utf-8")
            self.cache_hit_count += 1
        elif self.offline:
            raise DemError(f"オフライン指定ですがタイルがキャッシュにありません: {key}")
        else:
            url = TILE_URL.format(source=key.source, z=key.z, x=key.x, y=key.y)
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    text = res.read().decode("utf-8")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    # 整備範囲外。全画素欠測のタイルとして扱う
                    text = ""
                else:
                    raise DemError(f"タイル取得に失敗しました {url}: {e}") from e
            except OSError as e:
                raise DemError(f"タイル取得に失敗しました {url}: {e}") from e
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            self.fetch_count += 1

        grid: list[list[Optional[float]]] = []
        for line in text.strip().split("\n"):
            if not line:
                continue
            row: list[Optional[float]] = []
            for cell in line.split(","):
                cell = cell.strip()
                row.append(None if cell in ("", "e") else float(cell))
            grid.append(row)
        if not grid:
            grid = [[None] * TILE_PIXELS for _ in range(TILE_PIXELS)]
        self._tiles[key] = grid
        return grid

    # -- 標高の取得 --------------------------------------------------------
    def elevation(self, lat: float, lon: float) -> Optional[float]:
        """指定座標の標高 [m]。欠測なら None。双一次内挿する。"""
        fx, fy = deg_to_tile_xy(lat, lon, self.zoom)
        # 画素中心を基準にした連続座標
        px = fx * TILE_PIXELS - 0.5
        py = fy * TILE_PIXELS - 0.5
        x0, y0 = math.floor(px), math.floor(py)
        tx, ty = px - x0, py - y0

        corners: list[Optional[float]] = []
        for dy in (0, 1):
            for dx in (0, 1):
                corners.append(self._pixel(x0 + dx, y0 + dy))
        if any(c is None for c in corners):
            # 欠測が混じるときは内挿せず最近傍で返す
            return self._pixel(round(px), round(py))
        c00, c10, c01, c11 = corners  # type: ignore[misc]
        top = c00 * (1 - tx) + c10 * tx      # type: ignore[operator]
        bottom = c01 * (1 - tx) + c11 * tx   # type: ignore[operator]
        return top * (1 - ty) + bottom * ty

    def _pixel(self, gx: int, gy: int) -> Optional[float]:
        """全体画素座標（z固定）での標高。"""
        tx, px = divmod(gx, TILE_PIXELS)
        ty, py = divmod(gy, TILE_PIXELS)
        n = 2 ** self.zoom
        if not (0 <= tx < n and 0 <= ty < n):
            return None
        grid = self._load_tile(TileKey(self.source, self.zoom, tx, ty))
        if py >= len(grid):
            return None
        row = grid[py]
        if px >= len(row):
            return None
        return row[px]

    # -- 事前取得 ----------------------------------------------------------
    def prefetch_bbox(self, min_lat: float, min_lon: float,
                      max_lat: float, max_lon: float,
                      margin_m: float = 0.0) -> int:
        """範囲に必要なタイルをまとめて取得し、タイル枚数を返す。

        遠望の判定でルート外の地形も見るため、`margin_m` で外側に広げられる。
        """
        if margin_m:
            d_lat = margin_m / 111_320.0
            mid = (min_lat + max_lat) / 2
            d_lon = margin_m / (111_320.0 * math.cos(math.radians(mid)))
            min_lat, max_lat = min_lat - d_lat, max_lat + d_lat
            min_lon, max_lon = min_lon - d_lon, max_lon + d_lon

        x0, y0 = deg_to_tile_xy(max_lat, min_lon, self.zoom)
        x1, y1 = deg_to_tile_xy(min_lat, max_lon, self.zoom)
        count = 0
        for tx in range(int(x0), int(x1) + 1):
            for ty in range(int(y0), int(y1) + 1):
                self._load_tile(TileKey(self.source, self.zoom, tx, ty))
                count += 1
        return count

    # -- 地形の見え方 ------------------------------------------------------
    def ray_profile(self, origin: LatLon, bearing_deg_: float,
                    max_distance_m: float = 2000.0,
                    step_m: float = 50.0) -> Iterator[tuple[float, Optional[float]]]:
        """指定方位に伸ばした地形断面を (距離[m], 標高[m]) で返す。"""
        rad = math.radians(bearing_deg_)
        m_per_deg_lat = 111_320.0
        m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(origin.lat))
        d = step_m
        while d <= max_distance_m:
            lat = origin.lat + (d * math.cos(rad)) / m_per_deg_lat
            lon = origin.lon + (d * math.sin(rad)) / m_per_deg_lon
            yield d, self.elevation(lat, lon)
            d += step_m

    def max_view_angle_deg(self, origin: LatLon, origin_ele: float,
                           bearing_deg_: float, max_distance_m: float = 2000.0,
                           step_m: float = 50.0,
                           eye_height_m: float = 1.5) -> tuple[float, float]:
        """その方位で視線を遮る最大の仰角 [deg] と、遮られるまでの距離 [m]。

        仰角が負なら地形が下がっていて遠望が利く（尾根・展望地の指標）。
        """
        eye = origin_ele + eye_height_m
        best_angle = -90.0
        best_dist = max_distance_m
        for dist, ele in self.ray_profile(origin, bearing_deg_, max_distance_m, step_m):
            if ele is None:
                continue
            angle = math.degrees(math.atan2(ele - eye, dist))
            if angle > best_angle:
                best_angle = angle
                best_dist = dist
        return best_angle, best_dist
