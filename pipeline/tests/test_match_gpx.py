"""GPX 読み込みとルート照合（gpx.py / match_gpx.py）のテスト。

実際のGPXと本番動画がまだ無いため、既知の形のルートとテレメトリを合成して
機能A-2の受け入れ条件を検証する。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import match_gpx as mg
from geo import LatLon, angle_diff_deg, bearing_deg, haversine_m
from gpx import load_gpx
from route_builder import (build_route, offset, write_gpx, write_summary,
                           write_telemetry)

# GPX は 2026-07-11 03:53:58 UTC = 12:53:58 JST 開始、1m/s で 600m 進む
GPX_START_UTC = datetime(2026, 7, 11, 3, 53, 58, tzinfo=timezone.utc)
VIDEO_START_LOCAL = "2026-07-11T12:53:58"
# GPSが固定されたまま更新されない実機の挙動を再現するための、登山地とは無関係な座標
FROZEN_GPS = (34.0, 135.0)


@pytest.fixture()
def route() -> list[tuple[float, float, float]]:
    return build_route()


# ---------------------------------------------------------------------------
# gpx.py
# ---------------------------------------------------------------------------
def test_load_gpx_reads_points_time_and_elevation(tmp_path: Path, route: list) -> None:
    p = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    track = load_gpx(p)
    assert len(track.points) == len(route)
    assert track.has_time is True
    assert track.points[0].ele == pytest.approx(200.0, abs=0.1)
    lo, hi = track.time_range
    assert lo == GPX_START_UTC
    assert (hi - lo).total_seconds() == pytest.approx(600.0, abs=1.0)


def test_load_gpx_without_time(tmp_path: Path, route: list) -> None:
    p = write_gpx(tmp_path / "notime.gpx", route, with_time=False)
    track = load_gpx(p)
    assert track.has_time is False
    with pytest.raises(ValueError):
        track.time_range


def test_position_at_interpolates(tmp_path: Path, route: list) -> None:
    track = load_gpx(write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC))
    # 300秒後 = 300m 進んだ地点
    pos, gap = track.position_at(GPX_START_UTC + timedelta(seconds=300))
    assert gap <= 5.0
    snapped = track.polyline.snap(pos.lat, pos.lon)
    assert snapped.along_m == pytest.approx(300.0, abs=3.0)


def test_position_at_clamps_outside_range(tmp_path: Path, route: list) -> None:
    track = load_gpx(write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC))
    pos, gap = track.position_at(GPX_START_UTC - timedelta(seconds=120))
    assert gap == pytest.approx(120.0, abs=1.0)
    assert (pos.lat, pos.lon) == pytest.approx((route[0][0], route[0][1]))


def test_load_gpx_rejects_too_few_points(tmp_path: Path) -> None:
    p = tmp_path / "empty.gpx"
    p.write_text('<?xml version="1.0"?><gpx><trk><trkseg/></trk></gpx>', encoding="utf-8")
    with pytest.raises(ValueError):
        load_gpx(p)


# ---------------------------------------------------------------------------
# 時刻照合（GPSが固定されている実機の挙動）
# ---------------------------------------------------------------------------
def _setup_time_mode(tmp_path: Path, route: list, count: int = 300,
                     interval_us: int = 1_000_000) -> tuple[Path, Path, Path]:
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    tel = write_telemetry(tmp_path / "telemetry.json", count,
                          interval_us=interval_us, gps=FROZEN_GPS)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    return gpx, tel, tmp_path / "track.json"


def test_auto_mode_refuses_time_matching(tmp_path: Path, route: list) -> None:
    """GPXの時刻は計画のことがあるので、auto では時刻照合を選ばない。"""
    gpx, tel, out = _setup_time_mode(tmp_path, route)
    with pytest.raises(mg.MatchError) as e:
        mg.run(str(gpx), [str(tel)], str(out), quiet=True)
    assert "--mode time" in str(e.value)


def test_time_mode_can_be_requested_explicitly(tmp_path: Path, route: list) -> None:
    gpx, tel, out = _setup_time_mode(tmp_path, route)
    meta = mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    assert meta["mode_used"] == "time"
    assert meta["media"][0]["distinct_gps_fix_count"] == 1


def test_time_mode_positions_follow_the_gpx_route(tmp_path: Path, route: list) -> None:
    gpx, tel, out = _setup_time_mode(tmp_path, route)
    mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    data = json.loads(out.read_text(encoding="utf-8"))
    samples = data["samples"]
    assert len(samples) == 300
    # 1フレーム=1秒、1m/s なので経路長は経過秒数とほぼ一致する
    for i in (0, 50, 150, 299):
        assert samples[i]["route_distance_m"] == pytest.approx(float(i), abs=3.0)
        assert samples[i]["match_method"] == "time"
        # 正解座標は固定GPSではなくGPX由来である
        assert (samples[i]["lat"], samples[i]["lon"]) != FROZEN_GPS
        assert samples[i]["raw_lat"] == FROZEN_GPS[0]


def test_timelapse_uses_real_time_not_video_time(tmp_path: Path, route: list) -> None:
    """1フレーム=実時間2秒のタイムラプスでも、実時刻でGPXを引く。"""
    gpx, tel, out = _setup_time_mode(tmp_path, route, count=300,
                                     interval_us=2_000_000)
    mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    # 実時間2秒/フレーム × 1m/s → 経路長はフレーム番号の2倍
    assert samples[100]["route_distance_m"] == pytest.approx(200.0, abs=4.0)
    assert samples[299]["route_distance_m"] == pytest.approx(598.0, abs=4.0)


def test_time_offset_shifts_the_match(tmp_path: Path, route: list) -> None:
    gpx, tel, out = _setup_time_mode(tmp_path, route)
    mg.run(str(gpx), [str(tel)], str(out), mode="time", time_offset_s=60.0, quiet=True)
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    assert samples[0]["route_distance_m"] == pytest.approx(60.0, abs=3.0)


def test_samples_outside_gpx_time_range_are_suspect(tmp_path: Path, route: list) -> None:
    """GPXが終わったあとまで撮り続けた分は suspect になる。"""
    gpx, tel, out = _setup_time_mode(tmp_path, route, count=800)
    meta = mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    assert meta["suspect_count"] > 0
    assert samples[0]["suspect"] is False
    assert samples[-1]["suspect"] is True
    assert samples[-1]["suspect_reason"] == "time_gap"


def test_missing_start_time_is_an_error(tmp_path: Path, route: list) -> None:
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    tel = write_telemetry(tmp_path / "nostart.json", 10, gps=FROZEN_GPS)
    with pytest.raises(mg.MatchError):
        mg.run(str(gpx), [str(tel)], str(tmp_path / "t.json"), quiet=True)


def test_start_override_is_used(tmp_path: Path, route: list) -> None:
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    tel = write_telemetry(tmp_path / "nostart.json", 60, gps=FROZEN_GPS)
    out = tmp_path / "track.json"
    mg.run(str(gpx), [str(tel)], str(out), mode="time",
           starts=["2026-07-11T12:55:58"], quiet=True)
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    # 開始が2分遅い → 120m 進んだ地点から始まる
    assert samples[0]["route_distance_m"] == pytest.approx(120.0, abs=3.0)


# ---------------------------------------------------------------------------
# 座標スナップ（GPSが生きている場合）
# ---------------------------------------------------------------------------
def test_snap_mode_reports_distance_and_flags_outliers(tmp_path: Path,
                                                       route: list) -> None:
    # 真北一直線のルートにして、東へのずれがそのまま垂直距離になるようにする
    straight = build_route(legs=((0.0, 500.0),))
    gpx = write_gpx(tmp_path / "r.gpx", straight, start=GPX_START_UTC)
    # ルートから東に 20m ずらした軌跡。ただし1点だけ 300m 飛ばす
    track_pts = []
    for i, (lat, lon, _along) in enumerate(straight[:100]):
        east = 300.0 if i == 50 else 20.0
        track_pts.append(offset(lat, lon, 0.0, east))
    tel = write_telemetry(tmp_path / "telemetry.json", 100, gps_track=track_pts)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    out = tmp_path / "track.json"

    meta = mg.run(str(gpx), [str(tel)], str(out), quiet=True)
    assert meta["mode_used"] == "snap"
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    normal = [s for s in samples if s["frame_index"] != 50]
    assert all(s["snap_distance_m"] == pytest.approx(20.0, abs=1.5) for s in normal)
    assert all(s["suspect"] is False for s in normal)
    outlier = next(s for s in samples if s["frame_index"] == 50)
    assert outlier["suspect"] is True
    assert outlier["suspect_reason"] == "snap_distance"
    assert meta["suspect_count"] == 1


def test_snap_mode_answer_is_on_the_route(tmp_path: Path, route: list) -> None:
    """スナップ後の座標は必ずGPXルート上にある（生GPSではない）。"""
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    track_pts = [offset(lat, lon, 0.0, 20.0) for lat, lon, _ in route[:60]]
    tel = write_telemetry(tmp_path / "telemetry.json", 60, gps_track=track_pts)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    out = tmp_path / "track.json"
    mg.run(str(gpx), [str(tel)], str(out), mode="snap", quiet=True)

    gpx_track = load_gpx(gpx)
    for s in json.loads(out.read_text(encoding="utf-8"))["samples"]:
        r = gpx_track.polyline.snap(s["lat"], s["lon"])
        assert r.distance_m == pytest.approx(0.0, abs=0.1)


# ---------------------------------------------------------------------------
# 複数メディア（DJIの自動分割）
# ---------------------------------------------------------------------------
def test_multiple_media_are_merged_in_time_order(tmp_path: Path, route: list) -> None:
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    tel_a = write_telemetry(tmp_path / "clip_a.json", 100, gps=FROZEN_GPS)
    tel_b = write_telemetry(tmp_path / "clip_b.json", 100, gps=FROZEN_GPS)
    write_summary(tmp_path / "clip_a_summary.json", "2026-07-11T12:53:58")
    write_summary(tmp_path / "clip_b_summary.json", "2026-07-11T12:57:58")
    out = tmp_path / "track.json"

    meta = mg.run(str(gpx), [str(tel_b), str(tel_a)], str(out), mode="time", quiet=True)
    assert meta["sample_count"] == 200
    assert {m["media_id"] for m in meta["media"]} == {"clip_a", "clip_b"}

    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    times = [s["real_time"] for s in samples]
    assert times == sorted(times)          # 引数の順に関わらず時系列で並ぶ
    assert samples[0]["media_id"] == "clip_a"
    assert samples[-1]["media_id"] == "clip_b"
    # 2本目は4分後スタート → 240m 地点から
    first_b = next(s for s in samples if s["media_id"] == "clip_b")
    assert first_b["route_distance_m"] == pytest.approx(240.0, abs=3.0)


# ---------------------------------------------------------------------------
# heading（カメラ方位）
# ---------------------------------------------------------------------------
def _route_headings(route: list, count: int) -> list[float]:
    """各フレーム時点の進行方位（1フレーム=1m進む前提）。"""
    headings = []
    for i in range(count):
        a = route[min(i, len(route) - 2)]
        b = route[min(i + 1, len(route) - 1)]
        headings.append(bearing_deg(LatLon(a[0], a[1]), LatLon(b[0], b[1])))
    return headings


def test_heading_convention_is_detected_and_applied(tmp_path: Path,
                                                    route: list) -> None:
    """規約が合っていれば一致率がしきい値を超え、heading_deg が出力される。"""
    count = 250
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    # 1フレーム=1秒=1m 進む。ルート点は5m刻みなので添字は 1/5
    headings = [_route_headings(route, count)[i // 5] for i in range(count)]
    tel = write_telemetry(tmp_path / "telemetry.json", count, gps=FROZEN_GPS,
                          quat_headings_deg=headings)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    out = tmp_path / "track.json"

    meta = mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    heading = meta["heading"]
    assert heading["straight_sample_count"] > 0
    assert heading["candidates"][0]["agreement"] >= 0.8
    assert heading["chosen"] is not None

    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    checked = [s for s in samples if "heading_deg" in s and "heading_route_deg" in s]
    assert len(checked) > 100
    agree = sum(1 for s in checked
                if abs(angle_diff_deg(s["heading_deg"], s["heading_route_deg"])) <= 20.0)
    assert agree / len(checked) >= 0.8


def test_route_heading_is_always_available_as_fallback(tmp_path: Path,
                                                       route: list) -> None:
    """クォータニオンが無くても、進行方位はモード②の初期視点に使える。"""
    gpx, tel, out = _setup_time_mode(tmp_path, route)
    meta = mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    assert meta["heading"]["chosen"] is None      # quat が無いので確定できない
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    assert all("heading_deg" not in s for s in samples)
    with_route = [s for s in samples if "heading_route_deg" in s]
    assert len(with_route) > 200
    assert with_route[10]["heading_route_deg"] == pytest.approx(0.0, abs=5.0)


def test_wrong_quaternion_convention_is_rejected(tmp_path: Path, route: list) -> None:
    """規約がどれとも合わない姿勢では heading_deg を出さない（誤った方位を配らない）。"""
    count = 250
    gpx = write_gpx(tmp_path / "r.gpx", route, start=GPX_START_UTC)
    # 進行方位とは無関係にぐるぐる回る姿勢
    headings = [(i * 37.0) % 360.0 for i in range(count)]
    tel = write_telemetry(tmp_path / "telemetry.json", count, gps=FROZEN_GPS,
                          quat_headings_deg=headings)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    out = tmp_path / "track.json"

    meta = mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    assert meta["heading"]["candidates"][0]["agreement"] < 0.8
    assert meta["heading"]["chosen"] is None
    samples = json.loads(out.read_text(encoding="utf-8"))["samples"]
    assert all("heading_deg" not in s for s in samples)


# ---------------------------------------------------------------------------
# 異常系
# ---------------------------------------------------------------------------
def test_no_gps_and_no_gpx_time_is_an_error(tmp_path: Path, route: list) -> None:
    gpx = write_gpx(tmp_path / "notime.gpx", route, with_time=False)
    tel = write_telemetry(tmp_path / "telemetry.json", 50, gps=FROZEN_GPS)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    with pytest.raises(mg.MatchError):
        mg.run(str(gpx), [str(tel)], str(tmp_path / "t.json"), quiet=True)


def test_bad_timezone_is_an_error(tmp_path: Path, route: list) -> None:
    gpx, tel, out = _setup_time_mode(tmp_path, route, count=10)
    with pytest.raises(mg.MatchError):
        mg.run(str(gpx), [str(tel)], str(out), tz="JST", quiet=True)


def test_cli_returns_error_code_on_failure(tmp_path: Path, route: list) -> None:
    gpx = write_gpx(tmp_path / "notime.gpx", route, with_time=False)
    tel = write_telemetry(tmp_path / "telemetry.json", 20, gps=FROZEN_GPS)
    write_summary(tmp_path / "telemetry_summary.json", VIDEO_START_LOCAL)
    code = mg.main(["--gpx", str(gpx), "--telemetry", str(tel),
                    "--out", str(tmp_path / "t.json")])
    assert code == 1


def test_cli_writes_track_json(tmp_path: Path, route: list) -> None:
    gpx, tel, out = _setup_time_mode(tmp_path, route, count=50)
    code = mg.main(["--gpx", str(gpx), "--telemetry", str(tel), "--out", str(out),
                    "--mode", "time"])
    assert code == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["meta"]["mode_used"] == "time"
    assert len(data["samples"]) == 50


def test_snapped_answer_never_uses_raw_gps(tmp_path: Path, route: list) -> None:
    """AGENTS.md の禁止事項：生GPSをそのまま正解にしないこと。"""
    gpx, tel, out = _setup_time_mode(tmp_path, route, count=100)
    mg.run(str(gpx), [str(tel)], str(out), mode="time", quiet=True)
    gpx_track = load_gpx(gpx)
    for s in json.loads(out.read_text(encoding="utf-8"))["samples"]:
        assert haversine_m(LatLon(s["lat"], s["lon"]),
                           LatLon(s["raw_lat"], s["raw_lon"])) > 1.0 or math.isclose(
                               s["route_distance_m"], 0.0, abs_tol=1e-6)
