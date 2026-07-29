"""標高タイル読み取り（dem.py）のテスト。

通信はせず、合成タイルをキャッシュに置いて offline モードで読む。
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from dem import DemError, DemReader, deg_to_tile_xy
from dem_builder import gaussian_terrain, tile_to_deg, write_tiles
from geo import LatLon

PEAK_LAT, PEAK_LON = 34.180, 136.100
Z = 14


@pytest.fixture(scope="module")
def cache(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """標高1000mの台地に、高さ300m・半径400mの山が1つある地形。"""
    d = tmp_path_factory.mktemp("dem_cache")
    terrain = gaussian_terrain([(PEAK_LAT, PEAK_LON, 300.0, 400.0)])
    write_tiles(d, "dem", Z, PEAK_LAT - 0.004, PEAK_LON - 0.004,
                PEAK_LAT + 0.004, PEAK_LON + 0.004, terrain, margin_m=1200.0)
    return d


@pytest.fixture()
def reader(cache: Path) -> DemReader:
    return DemReader(source="dem", cache_dir=cache, offline=True)


def test_tile_coordinate_roundtrip() -> None:
    x, y = deg_to_tile_xy(PEAK_LAT, PEAK_LON, Z)
    lat, lon = tile_to_deg(x, y, Z)
    assert lat == pytest.approx(PEAK_LAT, abs=1e-9)
    assert lon == pytest.approx(PEAK_LON, abs=1e-9)


def test_elevation_at_summit_and_slope(reader: DemReader) -> None:
    summit = reader.elevation(PEAK_LAT, PEAK_LON)
    assert summit is not None
    assert summit == pytest.approx(1300.0, abs=5.0)
    # 山頂から北に400m（半径ぶん）→ exp(-0.5) ≒ 0.607 → 約1182m
    north = reader.elevation(PEAK_LAT + 400 / 111_320.0, PEAK_LON)
    assert north is not None
    assert north == pytest.approx(1000 + 300 * math.exp(-0.5), abs=8.0)


def test_elevation_outside_cache_raises_in_offline_mode(reader: DemReader) -> None:
    with pytest.raises(DemError):
        reader.elevation(35.0, 137.0)


def test_unknown_source_is_rejected() -> None:
    with pytest.raises(DemError):
        DemReader(source="dem99")


def test_prefetch_counts_tiles(cache: Path) -> None:
    r = DemReader(source="dem", cache_dir=cache, offline=True)
    n = r.prefetch_bbox(PEAK_LAT - 0.002, PEAK_LON - 0.002,
                        PEAK_LAT + 0.002, PEAK_LON + 0.002)
    assert n >= 1
    assert r.fetch_count == 0          # offline なので通信していない
    assert r.cache_hit_count == n


def test_ray_profile_descends_from_the_summit(reader: DemReader) -> None:
    profile = list(reader.ray_profile(LatLon(PEAK_LAT, PEAK_LON), 0.0,
                                      max_distance_m=800.0, step_m=100.0))
    eles = [e for _d, e in profile if e is not None]
    assert len(eles) == 8
    assert eles == sorted(eles, reverse=True)   # 山頂から離れるほど低い


def test_view_angle_is_negative_on_the_summit(reader: DemReader) -> None:
    """山頂ではどの方位も見下ろしになる（遠望が利く）。"""
    for az in (0.0, 90.0, 180.0, 270.0):
        angle, _dist = reader.max_view_angle_deg(
            LatLon(PEAK_LAT, PEAK_LON), 1300.0, az,
            max_distance_m=800.0, step_m=100.0)
        assert angle < 0.0


def test_view_angle_is_positive_when_the_peak_blocks(reader: DemReader) -> None:
    """山の北側の裾からは、南を向くと山体に遮られる。"""
    lat = PEAK_LAT + 700 / 111_320.0
    ele = reader.elevation(lat, PEAK_LON)
    assert ele is not None
    south, _ = reader.max_view_angle_deg(LatLon(lat, PEAK_LON), ele, 180.0,
                                         max_distance_m=800.0, step_m=50.0)
    north, _ = reader.max_view_angle_deg(LatLon(lat, PEAK_LON), ele, 0.0,
                                         max_distance_m=800.0, step_m=50.0)
    assert south > 0.0      # 山側は仰ぎ見る
    assert north < south     # 反対側の方が開けている
