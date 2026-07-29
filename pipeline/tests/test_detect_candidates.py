"""候補検出（detect_candidates.py）のテスト。

既知の形の地形とルートを合成し、期待どおりの種別・位置が出るかを見る。
DEMは合成タイルを offline で読むので通信しない。
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

import detect_candidates as dc
import frame_quality as fq
import match_gpx as mg
from dem_builder import gaussian_terrain, ridge_terrain, write_tiles
from geo import LatLon, haversine_m
from route_builder import build_route, write_gpx, write_summary, write_telemetry

Z = 14
BASE_LAT, BASE_LON = 34.173, 136.100
# 南から北へ 668m 離れた2つの山（間がコルになる）
PEAK_A = (34.176, 136.100, 300.0, 250.0)
PEAK_B = (34.182, 136.100, 250.0, 250.0)


def _run(tmp_path: Path, gpx: Path, cache: Path, **kw: Any) -> dict[str, Any]:
    out = tmp_path / "candidates.json"
    dc.run(gpx=str(gpx), out_path=str(out), dem_offline=True,
           dem_cache_dir=str(cache), quiet=True, **kw)
    return json.loads(out.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def two_peak_cache(tmp_path_factory: pytest.TempPathFactory) -> Path:
    d = tmp_path_factory.mktemp("dem_two_peaks")
    terrain = gaussian_terrain([PEAK_A, PEAK_B])
    write_tiles(d, "dem", Z, BASE_LAT - 0.002, BASE_LON - 0.004,
                BASE_LAT + 0.014, BASE_LON + 0.004, terrain)
    return d


@pytest.fixture(scope="module")
def ridge_cache(tmp_path_factory: pytest.TempPathFactory) -> Path:
    d = tmp_path_factory.mktemp("dem_ridge")
    terrain = ridge_terrain(BASE_LAT, BASE_LON, height_m=200.0, width_m=120.0)
    write_tiles(d, "dem", Z, BASE_LAT - 0.002, BASE_LON - 0.004,
                BASE_LAT + 0.014, BASE_LON + 0.004, terrain)
    return d


@pytest.fixture()
def straight_north(tmp_path: Path) -> Path:
    """2つの山頂を貫いて南から北へ 1330m の直線ルート。"""
    route = build_route(BASE_LAT, BASE_LON, legs=((0.0, 1330.0),), step_m=10.0)
    return write_gpx(tmp_path / "straight.gpx", route,
                     start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))


# ---------------------------------------------------------------------------
# ピーク・コル
# ---------------------------------------------------------------------------
def test_peaks_and_col_are_detected_at_the_right_places(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    data = _run(tmp_path, straight_north, two_peak_cache,
                types=("peak", "col"))
    cands = data["candidates"]
    peaks = [c for c in cands if c["type"] == "peak"]
    cols = [c for c in cands if c["type"] == "col"]
    assert len(peaks) == 2
    assert len(cols) == 1

    # 山頂は合成した位置と一致する
    for expect in (PEAK_A, PEAK_B):
        assert any(haversine_m(LatLon(p["lat"], p["lon"]),
                               LatLon(expect[0], expect[1])) < 40.0 for p in peaks)
    # コルは2つの山頂の間にある
    col = cols[0]
    assert PEAK_A[0] < col["lat"] < PEAK_B[0]
    assert col["elevation_m"] < min(p["elevation_m"] for p in peaks)


def test_prominence_threshold_filters_small_bumps(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    strict = _run(tmp_path, straight_north, two_peak_cache,
                  types=("peak",), peak_prominence_m=400.0)
    assert strict["meta"]["by_type"]["peak"] == 0


def test_peak_score_grows_with_prominence(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    peaks = [c for c in _run(tmp_path, straight_north, two_peak_cache,
                             types=("peak",))["candidates"]]
    peaks.sort(key=lambda c: -c["elevation_m"])
    assert peaks[0]["score"] >= peaks[1]["score"]
    assert all(0.0 <= p["score"] <= 1.0 for p in peaks)


# ---------------------------------------------------------------------------
# 屈曲
# ---------------------------------------------------------------------------
def test_bend_is_detected_at_the_corner(tmp_path: Path,
                                        two_peak_cache: Path) -> None:
    route = build_route(BASE_LAT, BASE_LON,
                        legs=((0.0, 300.0), (90.0, 300.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "corner.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, two_peak_cache, types=("bend",))
    bends = data["candidates"]
    assert len(bends) == 1
    assert bends[0]["route_distance_m"] == pytest.approx(300.0, abs=30.0)
    assert bends[0]["detail"]["bearing_change_deg"] == pytest.approx(90.0, abs=10.0)


def test_gentle_curve_is_not_a_bend(tmp_path: Path, two_peak_cache: Path) -> None:
    route = build_route(BASE_LAT, BASE_LON,
                        legs=((0.0, 200.0), (10.0, 200.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "gentle.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, two_peak_cache, types=("bend",))
    assert data["meta"]["by_type"]["bend"] == 0


# ---------------------------------------------------------------------------
# 重複の間引き（往復・周回で同じ場所を2度通る）
# ---------------------------------------------------------------------------
def test_out_and_back_does_not_produce_duplicate_points(
        tmp_path: Path, two_peak_cache: Path) -> None:
    """往復ルートでも同じ山頂が2回候補にならない。"""
    route = build_route(BASE_LAT, BASE_LON,
                        legs=((0.0, 1330.0), (180.0, 1330.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "outback.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, two_peak_cache, types=("peak", "col"))
    cands = data["candidates"]
    assert data["meta"]["raw_candidate_count"] > len(cands)  # 間引かれている
    for i, a in enumerate(cands):
        for b in cands[i + 1:]:
            assert haversine_m(LatLon(a["lat"], a["lon"]),
                               LatLon(b["lat"], b["lon"])) >= 150.0


def test_type_priority_keeps_the_peak_over_a_bend(
        tmp_path: Path, two_peak_cache: Path) -> None:
    """山頂で急に曲がる場合、bend ではなく peak を残す（出題として特定しやすい方）。"""
    # PEAK_A（南の山頂）で東に折れるルート
    route = build_route(BASE_LAT, BASE_LON,
                        legs=((0.0, 334.0), (90.0, 300.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "peakbend.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, two_peak_cache, types=("peak", "bend"))
    near_summit = [c for c in data["candidates"]
                   if haversine_m(LatLon(c["lat"], c["lon"]),
                                  LatLon(PEAK_A[0], PEAK_A[1])) < 150.0]
    assert len(near_summit) == 1
    assert near_summit[0]["type"] == "peak"


# ---------------------------------------------------------------------------
# 尾根・展望
# ---------------------------------------------------------------------------
def test_ridge_view_prefers_open_terrain(tmp_path: Path,
                                         two_peak_cache: Path) -> None:
    """山頂周辺は開けているので ridge_view が立つ。"""
    route = build_route(PEAK_A[0] - 0.0009, BASE_LON, legs=((0.0, 200.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "summit.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, two_peak_cache, types=("ridge_view",))
    views = data["candidates"]
    assert len(views) >= 1
    assert all(v["detail"]["openness"] >= 0.3 for v in views)
    assert all(v["detail"]["min_view_angle_deg"] < 0 for v in views)


def test_ridge_start_is_detected_when_stepping_onto_a_ridge(
        tmp_path: Path, ridge_cache: Path) -> None:
    """東側の斜面から尾根に乗り上げ、そのまま尾根を北上するルート。"""
    start_lat = BASE_LAT
    start_lon = BASE_LON + 0.0035          # 尾根から東に約320m
    route = build_route(start_lat, start_lon,
                        legs=((270.0, 320.0), (0.0, 400.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "ridge.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    data = _run(tmp_path, gpx, ridge_cache, types=("ridge_start",))
    starts = data["candidates"]
    assert len(starts) >= 1
    # 尾根線（BASE_LON）付近で立つ
    assert min(abs(s["lon"] - BASE_LON) for s in starts) < 0.0012
    assert all(s["detail"]["ridgeness_m"] >= 4.0 for s in starts)


# ---------------------------------------------------------------------------
# 入力の違い（動画あり／なし）
# ---------------------------------------------------------------------------
def test_gpx_only_mode_marks_candidates_as_frameless(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    """動画が無い場合は切り出し時刻を持たない＝3Dビューのみで出題する候補になる。"""
    data = _run(tmp_path, straight_north, two_peak_cache)
    assert data["meta"]["with_frame"] == 0
    assert all(c["has_frame"] is False for c in data["candidates"])
    assert all("frame_time_s" not in c for c in data["candidates"])
    assert data["meta"]["source"]["kind"] == "gpx"


def test_track_mode_carries_frame_time_and_media_id(
        tmp_path: Path, two_peak_cache: Path) -> None:
    """カメラGPSが生きている動画では、候補に切り出し時刻と media_id が付く。"""
    route = build_route(BASE_LAT, BASE_LON, legs=((0.0, 1330.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc),
                    speed_mps=1.0)
    tel = write_telemetry(tmp_path / "clip.json", 1300, gps=(BASE_LAT, BASE_LON))
    write_summary(tmp_path / "clip_summary.json", "2026-06-11T08:00:00")
    track = tmp_path / "track.json"
    mg.run(str(gpx), [str(tel)], str(track), mode="time", quiet=True)

    out = tmp_path / "candidates.json"
    dc.run(track=str(track), out_path=str(out), dem_offline=True,
           dem_cache_dir=str(two_peak_cache), quiet=True)
    data = json.loads(out.read_text(encoding="utf-8"))

    assert data["meta"]["source"]["kind"] == "track"
    assert data["meta"]["with_frame"] == data["meta"]["candidate_count"] > 0
    for c in data["candidates"]:
        assert c["has_frame"] is True
        assert c["media_id"] == "clip"
        assert 0.0 <= c["frame_time_s"] <= 1300 / 29.97
        # 進行方位はモード②の初期視点用に引き継がれる
        assert "heading_route_deg" in c


def test_suspect_samples_are_excluded(tmp_path: Path, two_peak_cache: Path) -> None:
    """GPXの時刻範囲外まで撮り続けた区間は候補にしない。"""
    route = build_route(BASE_LAT, BASE_LON, legs=((0.0, 600.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route,
                    start=datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc))
    tel = write_telemetry(tmp_path / "clip.json", 1500, gps=(BASE_LAT, BASE_LON))
    write_summary(tmp_path / "clip_summary.json", "2026-06-11T08:00:00")
    track = tmp_path / "track.json"
    meta = mg.run(str(gpx), [str(tel)], str(track), mode="time", quiet=True)
    assert meta["suspect_count"] > 0

    out = tmp_path / "candidates.json"
    dc.run(track=str(track), out_path=str(out), dem_offline=True,
           dem_cache_dir=str(two_peak_cache), quiet=True)
    data = json.loads(out.read_text(encoding="utf-8"))
    # 候補はGPXの範囲内（600m）に収まる
    assert all(c["route_distance_m"] <= 610.0 for c in data["candidates"])


# ---------------------------------------------------------------------------
# DEMなし・異常系
# ---------------------------------------------------------------------------
def test_without_dem_peaks_come_from_gpx_elevation(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    """--no-dem では尾根系は出ないが、GPXの標高でピーク・コルは出る。"""
    out = tmp_path / "candidates.json"
    dc.run(gpx=str(straight_north), out_path=str(out), use_dem=False, quiet=True)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["meta"]["dem"]["used"] is False
    assert data["meta"]["by_type"]["ridge_view"] == 0
    assert data["meta"]["by_type"]["ridge_start"] == 0
    # write_gpx は経路長に比例した標高を書くので単調増加＝ピークは出ない
    assert data["meta"]["by_type"]["peak"] == 0


def test_requires_exactly_one_source(tmp_path: Path, straight_north: Path) -> None:
    with pytest.raises(dc.DetectError):
        dc.run(quiet=True)
    with pytest.raises(dc.DetectError):
        dc.run(track="a.json", gpx=str(straight_north), quiet=True)


def test_cli_writes_candidates(tmp_path: Path, straight_north: Path,
                               two_peak_cache: Path) -> None:
    out = tmp_path / "candidates.json"
    code = dc.main(["--gpx", str(straight_north), "--out", str(out), "--no-dem"])
    assert code == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert "meta" in data and "candidates" in data


def test_cli_reports_error_for_missing_file(tmp_path: Path) -> None:
    code = dc.main(["--gpx", str(tmp_path / "nope.gpx"),
                    "--out", str(tmp_path / "o.json"), "--no-dem"])
    assert code == 1


# ---------------------------------------------------------------------------
# フレーム品質ゲート
# ---------------------------------------------------------------------------
def test_parse_video_args() -> None:
    assert dc.parse_video_args(None) == {}
    assert dc.parse_video_args(["a.mp4"]) == {"*": "a.mp4"}
    assert dc.parse_video_args(["clip_a=a.mp4", "clip_b=b.mp4"]) == {
        "clip_a": "a.mp4", "clip_b": "b.mp4"}


@pytest.mark.skipif(not fq.ffmpeg_available(), reason="ffmpeg が無い環境ではスキップ")
def test_frame_quality_flags_the_blurred_half(tmp_path: Path) -> None:
    """後半だけボカした動画で、後半の候補が low_quality になる。"""
    video = tmp_path / "half_blur.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=640x360:rate=30:duration=4",
         "-vf", "boxblur=12:2:enable='between(t,2,4)'",
         "-pix_fmt", "yuv420p", str(video)],
        capture_output=True, check=True)

    cands: list[dict[str, Any]] = [
        {"id": f"c{i}", "media_id": "clip", "frame_time_s": t}
        for i, t in enumerate((0.5, 1.0, 1.5, 2.5, 3.0, 3.5))
    ]
    stats = dc.apply_frame_quality(cands, {"clip": str(video)})

    assert stats["evaluated"] == 6
    assert stats["failed"] == 0
    assert stats["low_quality"] == 3
    assert [c["low_quality"] for c in cands] == [False, False, False, True, True, True]
    assert all("blur" in c["low_quality_reasons"] for c in cands[3:])
    assert all("low_quality_reasons" not in c for c in cands[:3])
    # しきい値は動画自身の中央値から決まる（絶対値ではない）
    assert stats["blur_threshold_used"] > fq.DEFAULT_BLUR_THRESHOLD


@pytest.mark.skipif(not fq.ffmpeg_available(), reason="ffmpeg が無い環境ではスキップ")
def test_uniformly_sharp_video_flags_nothing(tmp_path: Path) -> None:
    video = tmp_path / "sharp.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=640x360:rate=30:duration=3",
         "-pix_fmt", "yuv420p", str(video)],
        capture_output=True, check=True)
    cands: list[dict[str, Any]] = [
        {"id": f"c{i}", "media_id": "clip", "frame_time_s": t}
        for i, t in enumerate((0.5, 1.0, 1.5, 2.0, 2.5))
    ]
    stats = dc.apply_frame_quality(cands, {"clip": str(video)})
    assert stats["low_quality"] == 0
    assert all(c["low_quality"] is False for c in cands)


def test_frame_quality_skips_candidates_without_frames(tmp_path: Path) -> None:
    cands: list[dict[str, Any]] = [{"id": "c0", "type": "peak"}]
    stats = dc.apply_frame_quality(cands, {"*": "nonexistent.mp4"})
    assert stats == {"evaluated": 0, "low_quality": 0, "failed": 0}
    assert "low_quality" not in cands[0]


def test_frame_quality_counts_failures(tmp_path: Path) -> None:
    cands: list[dict[str, Any]] = [
        {"id": "c0", "media_id": "clip", "frame_time_s": 1.0}]
    stats = dc.apply_frame_quality(cands, {"clip": str(tmp_path / "missing.mp4")})
    assert stats["failed"] == 1
    assert stats["evaluated"] == 0


def test_candidate_ids_are_unique_and_ordered(
        tmp_path: Path, straight_north: Path, two_peak_cache: Path) -> None:
    cands = _run(tmp_path, straight_north, two_peak_cache)["candidates"]
    ids = [c["id"] for c in cands]
    assert len(set(ids)) == len(ids)
    dists = [c["route_distance_m"] for c in cands]
    assert dists == sorted(dists)
