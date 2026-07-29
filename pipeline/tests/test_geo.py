"""幾何ヘルパ（geo.py）のテスト。"""
from __future__ import annotations

import math

import pytest

from geo import (LatLon, LocalPlane, Polyline, angle_diff_deg, bearing_deg,
                 circular_mean_deg, haversine_m, normalize_quat,
                 quat_to_heading_deg, rotate_by_quat)
from route_builder import build_route, offset


def test_haversine_matches_known_distance() -> None:
    # 緯度0.001度 ≒ 111.19m
    d = haversine_m(LatLon(34.4, 135.87), LatLon(34.401, 135.87))
    assert d == pytest.approx(111.19, abs=0.1)


def test_haversine_is_symmetric_and_zero_for_same_point() -> None:
    a, b = LatLon(34.18049, 136.09706), LatLon(34.188, 136.115)
    assert haversine_m(a, a) == 0.0
    assert haversine_m(a, b) == pytest.approx(haversine_m(b, a), abs=1e-9)


@pytest.mark.parametrize("north,east,expected", [
    (100.0, 0.0, 0.0),
    (0.0, 100.0, 90.0),
    (-100.0, 0.0, 180.0),
    (0.0, -100.0, 270.0),
    (100.0, 100.0, 45.0),
])
def test_bearing_deg(north: float, east: float, expected: float) -> None:
    lat, lon = offset(34.4, 135.87, north, east)
    assert bearing_deg(LatLon(34.4, 135.87), LatLon(lat, lon)) == pytest.approx(
        expected, abs=0.5)


def test_angle_diff_wraps_around_north() -> None:
    assert angle_diff_deg(350.0, 10.0) == pytest.approx(-20.0)
    assert angle_diff_deg(10.0, 350.0) == pytest.approx(20.0)


def test_local_plane_roundtrip() -> None:
    plane = LocalPlane(34.4, 135.87)
    x, y = plane.to_xy(34.405, 135.875)
    back = plane.to_latlon(x, y)
    assert back.lat == pytest.approx(34.405, abs=1e-9)
    assert back.lon == pytest.approx(135.875, abs=1e-9)


def test_polyline_snap_finds_perpendicular_foot() -> None:
    # 真北に200m伸びる直線
    a = LatLon(34.4, 135.87)
    b_lat, b_lon = offset(34.4, 135.87, 200.0, 0.0)
    line = Polyline([a, LatLon(b_lat, b_lon)])
    # 100m北・30m東の点 → 30m east に落ちる
    p_lat, p_lon = offset(34.4, 135.87, 100.0, 30.0)
    r = line.snap(p_lat, p_lon)
    assert r.distance_m == pytest.approx(30.0, abs=0.5)
    assert r.along_m == pytest.approx(100.0, abs=0.5)


def test_polyline_snap_clamps_to_endpoints() -> None:
    a = LatLon(34.4, 135.87)
    b_lat, b_lon = offset(34.4, 135.87, 100.0, 0.0)
    line = Polyline([a, LatLon(b_lat, b_lon)])
    far_lat, far_lon = offset(34.4, 135.87, -50.0, 0.0)
    r = line.snap(far_lat, far_lon)
    assert r.along_m == pytest.approx(0.0, abs=0.5)
    assert r.distance_m == pytest.approx(50.0, abs=0.5)


def test_polyline_snap_with_hint_matches_full_search() -> None:
    pts = [LatLon(lat, lon) for lat, lon, _ in build_route()]
    line = Polyline(pts)
    for i in range(0, len(pts) - 1, 7):
        mid_lat = (pts[i].lat + pts[i + 1].lat) / 2
        mid_lon = (pts[i].lon + pts[i + 1].lon) / 2
        full = line.snap(mid_lat, mid_lon)
        hinted = line.snap(mid_lat, mid_lon, hint_index=max(0, i - 3), window=5)
        assert hinted.along_m == pytest.approx(full.along_m, abs=0.01)


def test_polyline_length_and_point_at() -> None:
    pts = [LatLon(lat, lon) for lat, lon, _ in build_route()]
    line = Polyline(pts)
    assert line.length_m == pytest.approx(600.0, abs=1.0)
    mid = line.point_at(line.length_m / 2)
    r = line.snap(mid.lat, mid.lon)
    assert r.distance_m == pytest.approx(0.0, abs=0.01)
    assert r.along_m == pytest.approx(line.length_m / 2, abs=0.5)
    # 範囲外は端点にクランプ
    assert line.point_at(-10).lat == pytest.approx(pts[0].lat)
    assert line.point_at(line.length_m + 10).lat == pytest.approx(pts[-1].lat)


def test_bbox_diagonal() -> None:
    pts = [LatLon(lat, lon) for lat, lon, _ in build_route()]
    line = Polyline(pts)
    # 北へ200m、北東へ200m、東へ200m → 対角は数百mのオーダー
    assert 300.0 < line.bbox_diagonal_m() < 700.0


# ---------------------------------------------------------------------------
# クォータニオン
# ---------------------------------------------------------------------------
def test_rotate_by_identity_quaternion() -> None:
    v = rotate_by_quat((1.0, 0.0, 0.0, 0.0), (1.0, 2.0, 3.0))
    assert v == pytest.approx((1.0, 2.0, 3.0))


@pytest.mark.parametrize("psi_deg", [0.0, 30.0, 90.0, 180.0, 270.0, 359.0])
def test_quat_to_heading_recovers_yaw(psi_deg: float) -> None:
    """NED・前方+x の規約では、z軸まわり psi の回転がそのまま方位になる。"""
    psi = math.radians(psi_deg)
    q = (math.cos(psi / 2), 0.0, 0.0, math.sin(psi / 2))
    assert quat_to_heading_deg(q, forward="x", world="ned") == pytest.approx(
        psi_deg % 360.0, abs=0.01)


def test_quat_to_heading_rejects_unknown_convention() -> None:
    with pytest.raises(ValueError):
        quat_to_heading_deg((1.0, 0.0, 0.0, 0.0), forward="w")
    with pytest.raises(ValueError):
        quat_to_heading_deg((1.0, 0.0, 0.0, 0.0), world="xyz")


def test_normalize_quat() -> None:
    q = normalize_quat((2.0, 0.0, 0.0, 0.0))
    assert q == pytest.approx((1.0, 0.0, 0.0, 0.0))
    with pytest.raises(ValueError):
        normalize_quat((0.0, 0.0, 0.0, 0.0))


def test_circular_mean_handles_north_wraparound() -> None:
    assert circular_mean_deg([350.0, 10.0]) == pytest.approx(0.0, abs=0.01)
    assert circular_mean_deg([80.0, 100.0]) == pytest.approx(90.0, abs=0.01)
    with pytest.raises(ValueError):
        circular_mean_deg([])
