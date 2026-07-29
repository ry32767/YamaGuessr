"""テスト用の合成DEMタイルを作るヘルパ。

本物の地理院タイルを叩かずに地形ロジックを検証するため、
解析的な地形（ガウス型の山を重ねたもの）をタイルキャッシュに書き出す。
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Callable, Sequence

from dem import TILE_PIXELS, deg_to_tile_xy

M_PER_DEG_LAT = 111_320.0


def tile_to_deg(x: float, y: float, z: int) -> tuple[float, float]:
    """タイル座標（小数可）を緯度経度に戻す。"""
    n = 2.0 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return lat, lon


def gaussian_terrain(peaks: Sequence[tuple[float, float, float, float]],
                     base_m: float = 1000.0) -> Callable[[float, float], float]:
    """(lat, lon, 高さ[m], 半径[m]) の山を重ねた地形関数を返す。"""
    def f(lat: float, lon: float) -> float:
        ele = base_m
        for plat, plon, height, radius in peaks:
            dy = (lat - plat) * M_PER_DEG_LAT
            dx = (lon - plon) * M_PER_DEG_LAT * math.cos(math.radians(lat))
            d2 = dx * dx + dy * dy
            ele += height * math.exp(-d2 / (2.0 * radius * radius))
        return ele
    return f


def ridge_terrain(center_lat: float, center_lon: float, height_m: float = 200.0,
                  width_m: float = 120.0, base_m: float = 1000.0
                  ) -> Callable[[float, float], float]:
    """南北に伸びる尾根（東西方向にだけ落ちる地形）。"""
    def f(lat: float, lon: float) -> float:
        dx = (lon - center_lon) * M_PER_DEG_LAT * math.cos(math.radians(lat))
        return base_m + height_m * math.exp(-(dx * dx) / (2.0 * width_m * width_m))
    return f


def write_tiles(cache_dir: Path, source: str, z: int,
                min_lat: float, min_lon: float, max_lat: float, max_lon: float,
                terrain: Callable[[float, float], float],
                margin_m: float = 2100.0) -> int:
    """範囲（＋余白）を覆うタイルを合成して書き出し、枚数を返す。"""
    d_lat = margin_m / M_PER_DEG_LAT
    mid = (min_lat + max_lat) / 2
    d_lon = margin_m / (M_PER_DEG_LAT * math.cos(math.radians(mid)))
    min_lat, max_lat = min_lat - d_lat, max_lat + d_lat
    min_lon, max_lon = min_lon - d_lon, max_lon + d_lon

    x0, y0 = deg_to_tile_xy(max_lat, min_lon, z)
    x1, y1 = deg_to_tile_xy(min_lat, max_lon, z)
    count = 0
    for tx in range(int(x0), int(x1) + 1):
        for ty in range(int(y0), int(y1) + 1):
            path = cache_dir / source / str(z) / str(tx) / f"{ty}.txt"
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            rows: list[str] = []
            for py in range(TILE_PIXELS):
                lat, _ = tile_to_deg(tx, ty + (py + 0.5) / TILE_PIXELS, z)
                cells: list[str] = []
                for px in range(TILE_PIXELS):
                    _, lon = tile_to_deg(tx + (px + 0.5) / TILE_PIXELS, ty, z)
                    cells.append(f"{terrain(lat, lon):.2f}")
                rows.append(",".join(cells))
            path.write_text("\n".join(rows), encoding="utf-8")
            count += 1
    return count
