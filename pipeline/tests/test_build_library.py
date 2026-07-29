"""画像ライブラリ（build_library.py）のテスト。

動画と写真を混ぜて一覧にできることを確認する。ffmpeg が無い環境では skip。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import build_library as bl
from test_exif import make_jpeg_with_exif

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"),
                                reason="ffmpeg が無い環境ではスキップ")


@pytest.fixture()
def video(tmp_path: Path) -> Path:
    path = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=640x360:rate=30:duration=10",
         "-pix_fmt", "yuv420p", str(path)],
        capture_output=True, check=True)
    return path


@pytest.fixture()
def photos(tmp_path: Path) -> Path:
    d = tmp_path / "photos"
    d.mkdir()
    for i, taken in enumerate(["2026:06:11 09:00:00", "2026:06:11 08:00:00"], 1):
        raw = d / f"raw{i}.jpg"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", "testsrc=size=800x600:rate=1:duration=1", "-frames:v", "1", str(raw)],
            capture_output=True, check=True)
        body = raw.read_bytes()
        raw.unlink()
        stub = make_jpeg_with_exif(d / f"stub{i}.jpg", taken=taken)
        block = stub.read_bytes()
        stub.unlink()
        (d / f"IMG_{i:04d}.jpg").write_bytes(block[:block.index(b"\xff\xda")] + body[2:])
    return d


def test_samples_video_at_the_interval(tmp_path: Path, video: Path) -> None:
    out = tmp_path / "library"
    meta = bl.run({"clip": str(video)}, None, str(out), interval_s=2.0, quiet=True)
    assert meta["video_frames"] == 5      # 10秒 ÷ 2秒
    assert meta["photos"] == 0
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    times = [e["time_s"] for e in index["images"]]
    assert times == [0.0, 2.0, 4.0, 6.0, 8.0]
    for entry in index["images"]:
        assert entry["kind"] == "video_frame"
        assert entry["media_id"] == "clip"
        assert (out / entry["file"]).stat().st_size > 0


def test_interval_changes_the_count(tmp_path: Path, video: Path) -> None:
    meta = bl.run({"clip": str(video)}, None, str(tmp_path / "lib"),
                  interval_s=5.0, quiet=True)
    assert meta["video_frames"] == 2


def test_collects_photos_with_exif_order(tmp_path: Path, photos: Path) -> None:
    out = tmp_path / "library"
    meta = bl.run({}, str(photos), str(out), quiet=True)
    assert meta["photos"] == 2
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    entries = [e for e in index["images"] if e["kind"] == "photo"]
    # 撮影日時の早い順（IMG_0002 が 08:00、IMG_0001 が 09:00）
    assert entries[0]["source"] == "IMG_0002.jpg"
    assert entries[0]["taken_local"].startswith("2026-06-11T08:00")
    assert all(e["photo_source"] for e in entries)


def test_mixes_video_and_photos(tmp_path: Path, video: Path, photos: Path) -> None:
    out = tmp_path / "library"
    meta = bl.run({"clip": str(video)}, str(photos), str(out),
                  interval_s=2.0, quiet=True)
    assert meta["count"] == meta["video_frames"] + meta["photos"] == 7
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    assert {e["kind"] for e in index["images"]} == {"video_frame", "photo"}
    # 画像IDは重複しない
    ids = [e["id"] for e in index["images"]]
    assert len(set(ids)) == len(ids)


def test_reports_unsupported_photos(tmp_path: Path, photos: Path) -> None:
    (photos / "IMG_9999.HEIC").write_bytes(b"\x00" * 32)
    meta = bl.run({}, str(photos), str(tmp_path / "lib"), quiet=True)
    assert meta["unsupported"] == ["IMG_9999.HEIC"]
    assert meta["photos"] == 2


def test_rebuilding_clears_old_entries(tmp_path: Path, video: Path) -> None:
    out = tmp_path / "library"
    bl.run({"clip": str(video)}, None, str(out), interval_s=1.0, quiet=True)
    before = len(list(out.glob("*.jpg")))
    bl.run({"clip": str(video)}, None, str(out), interval_s=5.0, quiet=True)
    after = len(list(out.glob("*.jpg")))
    assert after < before     # 前回の残りが混ざらない


def test_no_material_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(bl.LibraryError):
        bl.run({}, None, str(tmp_path / "lib"), quiet=True)


def test_missing_video_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(bl.LibraryError):
        bl.run({"clip": str(tmp_path / "nope.mp4")}, None, str(tmp_path / "lib"),
               quiet=True)


def test_parse_video_args_defaults_media_id_from_filename() -> None:
    assert bl.parse_video_args(["Source/DJI_0007.MP4"]) == {
        "DJI_0007": "Source/DJI_0007.MP4"}
    assert bl.parse_video_args(["a=x.mp4"]) == {"a": "x.mp4"}


def test_cli(tmp_path: Path, video: Path) -> None:
    code = bl.main(["--video", f"clip={video}", "--out-dir", str(tmp_path / "lib"),
                    "--interval-s", "5"])
    assert code == 0
    assert (tmp_path / "lib" / "index.json").exists()


def test_cli_reports_error(tmp_path: Path) -> None:
    assert bl.main(["--out-dir", str(tmp_path / "lib")]) == 1
