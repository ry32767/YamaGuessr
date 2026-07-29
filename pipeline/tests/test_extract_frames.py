"""フレーム切り出し（extract_frames.py）のテスト。

ffmpeg で合成した動画を使う。ffmpeg が無い環境では skip する。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import extract_frames as ef

pytestmark = pytest.mark.skipif(not ef.ffmpeg_available(),
                                reason="ffmpeg が無い環境ではスキップ")


@pytest.fixture(scope="module")
def video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """メタデータ付きの 20 秒テスト動画。"""
    path = tmp_path_factory.mktemp("v") / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=1920x1080:rate=30:duration=20",
         "-metadata", "location=+34.0000+135.0000/",
         "-metadata", "comment=secret",
         "-pix_fmt", "yuv420p", str(path)],
        capture_output=True, check=True)
    return path


# ---------------------------------------------------------------------------
# 時刻オフセットのユーティリティ
# ---------------------------------------------------------------------------
def test_preview_offsets_cover_plus_minus_5s_in_half_steps() -> None:
    offs = ef.preview_offsets()
    assert offs[0] == -5.0
    assert offs[-1] == 5.0
    assert len(offs) == 21
    assert offs[11] == 0.5
    assert 0.0 in offs


def test_offset_key_is_filename_safe() -> None:
    assert ef.offset_key(0.0) == "p0_0"
    assert ef.offset_key(2.5) == "p2_5"
    assert ef.offset_key(-0.5) == "m0_5"
    assert ef.offset_key(-5.0) == "m5_0"


def test_parse_and_resolve_video_args() -> None:
    videos = ef.parse_video_args(["a=one.mp4", "b=two.mp4"])
    assert ef.resolve_video(videos, "a") == "one.mp4"
    assert ef.resolve_video(videos, "zzz") is None
    fallback = ef.parse_video_args(["only.mp4"])
    assert ef.resolve_video(fallback, "anything") == "only.mp4"


# ---------------------------------------------------------------------------
# プレビュー
# ---------------------------------------------------------------------------
def test_extract_preview_set_writes_the_whole_window(video: Path,
                                                     tmp_path: Path) -> None:
    made = ef.extract_preview_set(str(video), 10.0, tmp_path / "c1")
    assert len(made) == 21
    assert made[0]["offset_s"] == -5.0
    assert made[0]["time_s"] == 5.0
    for m in made:
        assert (tmp_path / "c1" / m["file"]).stat().st_size > 0


def test_preview_skips_negative_times(video: Path, tmp_path: Path) -> None:
    """動画の先頭付近では、負の時刻ぶんは作らない。"""
    made = ef.extract_preview_set(str(video), 1.0, tmp_path / "c2")
    assert all(m["time_s"] >= 0 for m in made)
    assert len(made) < 21


def test_build_previews_writes_index(video: Path, tmp_path: Path) -> None:
    cands = {"candidates": [
        {"id": "cand-0001", "media_id": "clip", "frame_time_s": 10.0},
        {"id": "cand-0002", "media_id": "clip", "frame_time_s": 12.0},
        {"id": "cand-0003"},                       # 画像なし地点（3D専用）
    ]}
    cpath = tmp_path / "candidates.json"
    cpath.write_text(json.dumps(cands), encoding="utf-8")

    meta = ef.build_previews(str(cpath), {"clip": str(video)},
                             str(tmp_path / "previews"), quiet=True)
    assert meta["with_previews"] == 2
    assert meta["skipped"] == 1

    index = json.loads((tmp_path / "previews" / "index.json").read_text(encoding="utf-8"))
    assert set(index["previews"]) == {"cand-0001", "cand-0002"}
    assert index["previews"]["cand-0001"]["base_time_s"] == 10.0
    assert len(index["previews"]["cand-0001"]["frames"]) == 21


# ---------------------------------------------------------------------------
# 本番画像
# ---------------------------------------------------------------------------
def _probe(path: Path) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=width,height,codec_name",
         "-show_entries", "format_tags", "-of", "json", str(path)],
        capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def test_final_frame_is_webp_within_size_and_long_edge(video: Path,
                                                       tmp_path: Path) -> None:
    out = tmp_path / "p-001.webp"
    info = ef.extract_final_frame(str(video), 10.0, out)
    assert info["bytes"] <= ef.FINAL_MAX_BYTES
    probe = _probe(out)
    stream = probe["streams"][0]
    assert stream["codec_name"] == "webp"
    assert max(stream["width"], stream["height"]) == ef.FINAL_LONG_EDGE


def test_final_frame_strips_all_metadata(video: Path, tmp_path: Path) -> None:
    """位置情報を画像に埋め込まない（AGENTS.md の禁止事項）。"""
    out = tmp_path / "p-002.webp"
    ef.extract_final_frame(str(video), 10.0, out)
    tags = _probe(out)["format"].get("tags", {})
    assert tags == {} or not any(
        "location" in k.lower() or "comment" in k.lower() for k in tags)
    # 生バイト列にも座標文字列が残っていない
    raw = out.read_bytes()
    assert b"135.0000" not in raw
    assert b"secret" not in raw


def test_final_frame_lowers_quality_to_fit(video: Path, tmp_path: Path) -> None:
    """上限に収まらなければ品質を1段ずつ落とす。"""
    big = ef.extract_final_frame(str(video), 10.0, tmp_path / "big.webp",
                                 max_bytes=10 ** 9)
    assert big["quality"] == ef.QUALITY_LADDER[0]

    limit = big["bytes"] - 1
    small = ef.extract_final_frame(str(video), 10.0, tmp_path / "small.webp",
                                   max_bytes=limit)
    assert small["bytes"] <= limit
    assert small["quality"] < big["quality"]


def test_impossible_size_limit_raises(video: Path, tmp_path: Path) -> None:
    with pytest.raises(ef.FrameExtractError):
        ef.extract_final_frame(str(video), 10.0, tmp_path / "p-004.webp",
                               max_bytes=200)


def test_build_final_frames_names_files_by_point_id(video: Path,
                                                    tmp_path: Path) -> None:
    """ファイル名に緯度経度を含めない（AGENTS.md の禁止事項）。"""
    confirmed = {"points": [
        {"id": "odaigahara-2026-06-11-001", "media_id": "clip",
         "frame_time_s": 8.0, "lat": 34.18519, "lon": 136.10931},
        {"id": "odaigahara-2026-06-11-002", "lat": 34.17, "lon": 136.09},  # 3D専用
    ]}
    cpath = tmp_path / "confirmed.json"
    cpath.write_text(json.dumps(confirmed), encoding="utf-8")
    out_dir = tmp_path / "images"

    meta = ef.build_final_frames(str(cpath), {"clip": str(video)}, str(out_dir),
                                 quiet=True)
    assert meta["images_written"] == 1
    assert meta["frameless"] == 1
    files = sorted(p.name for p in out_dir.iterdir())
    assert files == ["odaigahara-2026-06-11-001.webp"]
    assert all("34.1" not in f and "136.1" not in f for f in files)
    assert meta["max_written_bytes"] <= ef.FINAL_MAX_BYTES


def test_cli_final_and_previews(video: Path, tmp_path: Path) -> None:
    cands = tmp_path / "candidates.json"
    cands.write_text(json.dumps(
        {"candidates": [{"id": "c1", "media_id": "clip", "frame_time_s": 10.0}]}),
        encoding="utf-8")
    assert ef.main(["previews", "--candidates", str(cands),
                    "--video", f"clip={video}",
                    "--out-dir", str(tmp_path / "pv")]) == 0

    confirmed = tmp_path / "confirmed.json"
    confirmed.write_text(json.dumps(
        {"points": [{"id": "p1", "media_id": "clip", "frame_time_s": 10.0}]}),
        encoding="utf-8")
    assert ef.main(["final", "--confirmed", str(confirmed),
                    "--video", f"clip={video}",
                    "--out-dir", str(tmp_path / "img")]) == 0
    assert (tmp_path / "img" / "p1.webp").exists()


def test_cli_reports_error_for_missing_input(tmp_path: Path) -> None:
    assert ef.main(["final", "--confirmed", str(tmp_path / "nope.json"),
                    "--video", "x.mp4", "--out-dir", str(tmp_path)]) == 1
