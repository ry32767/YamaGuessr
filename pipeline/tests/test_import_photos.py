"""写真の取り込み（import_photos.py）のテスト。

EXIF付きJPEGを合成し、ffmpeg で実際にWebPへ変換するところまで確認する。
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

import import_photos as ip
from geo import LatLon, haversine_m
from gpx import load_gpx
from route_builder import build_route, write_gpx
from test_exif import make_jpeg_with_exif

# GPXは 2026-06-10 23:00:00 UTC（= 6/11 08:00 JST）から 1m/s で 600m
GPX_START_UTC = datetime(2026, 6, 10, 23, 0, tzinfo=timezone.utc)
MOUNTAIN_ID = "odaigahara-2026-06-11"

pytestmark = pytest.mark.skipif(
    not __import__("shutil").which("ffmpeg"), reason="ffmpeg が無い環境ではスキップ")


def _real_jpeg(path: Path, taken: str, size: str = "640x480") -> Path:
    """ffmpeg で本物の画像を作り、そこにEXIFを載せ替える。

    合成JPEGは画素を持たないので、変換のテストには実画像が要る。
    """
    raw = path.with_suffix(".raw.jpg")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", f"testsrc=size={size}:rate=1:duration=1", "-frames:v", "1", str(raw)],
        capture_output=True, check=True)
    body = raw.read_bytes()
    raw.unlink()
    # 合成したEXIFブロックの後ろに、本物のJPEGの中身（SOI以降）を繋ぐ
    stub = make_jpeg_with_exif(path.with_suffix(".stub.jpg"), taken=taken)
    exif_block = stub.read_bytes()
    stub.unlink()
    app1_end = exif_block.index(b"\xff\xda")
    path.write_bytes(exif_block[:app1_end] + body[2:])
    return path


@pytest.fixture()
def gpx(tmp_path: Path) -> Path:
    route = build_route(34.180, 136.098, legs=((0.0, 600.0),), step_m=10.0)
    return write_gpx(tmp_path / "route.gpx", route, start=GPX_START_UTC, speed_mps=1.0)


@pytest.fixture()
def photos(tmp_path: Path) -> Path:
    d = tmp_path / "photos"
    d.mkdir()
    # 08:00 JST から 100秒後、300秒後 に撮った2枚
    _real_jpeg(d / "IMG_0002.jpg", "2026:06:11 08:05:00")
    _real_jpeg(d / "IMG_0001.jpg", "2026:06:11 08:01:40")
    return d


def test_imports_photos_into_points(tmp_path: Path, gpx: Path, photos: Path) -> None:
    out = tmp_path / "confirmed.json"
    images = tmp_path / "frames"
    meta = ip.run(str(gpx), str(photos), MOUNTAIN_ID, "大台ヶ原",
                  str(out), str(images), quiet=True)
    assert meta["imported"] == 2
    assert meta["skipped"] == []

    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["mountain"]["id"] == MOUNTAIN_ID
    points = data["points"]
    assert len(points) == 2
    # 撮影時刻の順に並び、IDは連番になる
    assert [p["id"] for p in points] == [f"{MOUNTAIN_ID}-p001", f"{MOUNTAIN_ID}-p002"]
    assert points[0]["photo_source"] == "IMG_0001.jpg"
    assert all(p["type"] == "photo" for p in points)
    assert all(p["match_method"] == "time" for p in points)


def test_position_comes_from_gpx_time(tmp_path: Path, gpx: Path, photos: Path) -> None:
    """写真の位置は撮影時刻からGPX上で決まる（1m/s なので秒数＝経路長）。"""
    out = tmp_path / "confirmed.json"
    ip.run(str(gpx), str(photos), MOUNTAIN_ID, "山", str(out),
           str(tmp_path / "frames"), quiet=True)
    points = json.loads(out.read_text(encoding="utf-8"))["points"]
    track = load_gpx(gpx)
    # 1枚目は 100秒後 → 100m 地点
    snapped = track.polyline.snap(points[0]["lat"], points[0]["lon"])
    assert snapped.along_m == pytest.approx(100.0, abs=5.0)
    # 2枚目は 300秒後 → 300m 地点
    snapped2 = track.polyline.snap(points[1]["lat"], points[1]["lon"])
    assert snapped2.along_m == pytest.approx(300.0, abs=5.0)
    # 2枚は 200m 離れている
    assert haversine_m(LatLon(points[0]["lat"], points[0]["lon"]),
                       LatLon(points[1]["lat"], points[1]["lon"])) == pytest.approx(
        200.0, abs=10.0)


def test_writes_webp_without_metadata(tmp_path: Path, gpx: Path, photos: Path) -> None:
    images = tmp_path / "frames"
    ip.run(str(gpx), str(photos), MOUNTAIN_ID, "山",
           str(tmp_path / "confirmed.json"), str(images), quiet=True)
    files = sorted(p.name for p in images.iterdir())
    assert files == [f"{MOUNTAIN_ID}-p001.webp", f"{MOUNTAIN_ID}-p002.webp"]
    for path in images.iterdir():
        assert path.stat().st_size <= ip.MAX_BYTES
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
             "-show_entries", "format_tags", "-of", "json", str(path)],
            capture_output=True, text=True, check=True)
        info = json.loads(probe.stdout)
        assert info["streams"][0]["codec_name"] == "webp"
        assert max(info["streams"][0]["width"], info["streams"][0]["height"]) <= ip.LONG_EDGE
        assert info["format"].get("tags", {}) == {}


def test_photo_outside_gpx_time_range_is_skipped(tmp_path: Path, gpx: Path) -> None:
    """別の山行の写真が紛れても、まったく違う場所の地点を作らない。"""
    d = tmp_path / "photos"
    d.mkdir()
    _real_jpeg(d / "IMG_0001.jpg", "2026:06:11 08:01:40")   # 範囲内
    _real_jpeg(d / "IMG_9999.jpg", "2026:07:11 12:53:58")   # 1か月後
    out = tmp_path / "confirmed.json"
    meta = ip.run(str(gpx), str(d), MOUNTAIN_ID, "山", str(out),
                  str(tmp_path / "frames"), quiet=True)
    assert meta["imported"] == 1
    assert len(meta["skipped"]) == 1
    assert "IMG_9999.jpg" == meta["skipped"][0]["file"]
    assert "外れ" in meta["skipped"][0]["reason"]


def test_time_offset_shifts_the_match(tmp_path: Path, gpx: Path, photos: Path) -> None:
    out = tmp_path / "confirmed.json"
    ip.run(str(gpx), str(photos), MOUNTAIN_ID, "山", str(out),
           str(tmp_path / "frames"), time_offset_s=100.0, quiet=True)
    points = json.loads(out.read_text(encoding="utf-8"))["points"]
    track = load_gpx(gpx)
    snapped = track.polyline.snap(points[0]["lat"], points[0]["lon"])
    assert snapped.along_m == pytest.approx(200.0, abs=5.0)


def test_heading_and_elevation_are_attached(tmp_path: Path, gpx: Path,
                                            photos: Path) -> None:
    out = tmp_path / "confirmed.json"
    ip.run(str(gpx), str(photos), MOUNTAIN_ID, "山", str(out),
           str(tmp_path / "frames"), quiet=True)
    point = json.loads(out.read_text(encoding="utf-8"))["points"][0]
    # ルートは真北へ伸びているので進行方位はほぼ0度
    assert point["heading_route_deg"] == pytest.approx(0.0, abs=5.0)
    assert point["elevation_m"] > 0


def test_heic_is_reported_not_crashed(tmp_path: Path, gpx: Path) -> None:
    d = tmp_path / "photos"
    d.mkdir()
    _real_jpeg(d / "IMG_0001.jpg", "2026:06:11 08:01:40")
    (d / "IMG_0002.HEIC").write_bytes(b"\x00" * 64)
    meta = ip.run(str(gpx), str(d), MOUNTAIN_ID, "山",
                  str(tmp_path / "c.json"), str(tmp_path / "frames"), quiet=True)
    assert meta["imported"] == 1
    assert meta["unsupported"] == ["IMG_0002.HEIC"]


def test_empty_photo_dir_is_an_error(tmp_path: Path, gpx: Path) -> None:
    d = tmp_path / "photos"
    d.mkdir()
    with pytest.raises(ip.ImportError_):
        ip.import_photos(str(gpx), str(d), MOUNTAIN_ID, "山",
                         str(tmp_path / "frames"), quiet=True)


def test_missing_photo_dir_is_an_error(tmp_path: Path, gpx: Path) -> None:
    with pytest.raises(ip.ImportError_):
        ip.list_photos(tmp_path / "nope")


def test_cli(tmp_path: Path, gpx: Path, photos: Path) -> None:
    out = tmp_path / "confirmed.json"
    code = ip.main(["--gpx", str(gpx), "--photos-dir", str(photos),
                    "--mountain-id", MOUNTAIN_ID, "--mountain-name", "山",
                    "--out", str(out), "--images-out", str(tmp_path / "frames")])
    assert code == 0
    assert out.exists()


def test_cli_reports_error(tmp_path: Path, gpx: Path) -> None:
    assert ip.main(["--gpx", str(gpx), "--photos-dir", str(tmp_path / "nope"),
                    "--mountain-id", "m", "--mountain-name", "山",
                    "--out", str(tmp_path / "c.json"),
                    "--images-out", str(tmp_path / "f")]) == 1


def test_parse_tz_minutes() -> None:
    assert ip.parse_tz_minutes("+09:00") == 540
    assert ip.parse_tz_minutes("-05:00") == -300
    with pytest.raises(ip.ImportError_):
        ip.parse_tz_minutes("JST")
