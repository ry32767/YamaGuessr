"""フレーム品質判定（frame_quality.py）のテスト。

ffmpeg で「シャープな映像」「ぼかした映像」「真っ暗な映像」を合成して比べる。
ffmpeg が無い環境では skip する。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import frame_quality as fq

pytestmark = pytest.mark.skipif(not fq.ffmpeg_available(),
                                reason="ffmpeg が無い環境ではスキップ")


def _make_video(path: Path, filters: str, duration: float = 2.0) -> Path:
    """lavfi の testsrc からテスト用動画を作る。"""
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=30:duration={duration}",
           "-vf", filters, "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, capture_output=True, check=True)
    return path


@pytest.fixture(scope="module")
def sharp(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _make_video(tmp_path_factory.mktemp("v") / "sharp.mp4", "null")


@pytest.fixture(scope="module")
def blurred(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _make_video(tmp_path_factory.mktemp("v") / "blur.mp4", "boxblur=12:2")


@pytest.fixture(scope="module")
def dark(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _make_video(tmp_path_factory.mktemp("v") / "dark.mp4", "eq=brightness=-0.55")


def test_grab_gray_frame_returns_expected_size(sharp: Path) -> None:
    data, w, h = fq.grab_gray_frame(sharp, 1.0)
    assert w == fq.ANALYSIS_WIDTH
    assert h == pytest.approx(180, abs=2)
    assert len(data) == w * h


def test_sharp_frame_scores_higher_than_blurred(sharp: Path, blurred: Path) -> None:
    s = fq.evaluate_frame(sharp, 1.0)
    b = fq.evaluate_frame(blurred, 1.0)
    assert s.blur_score > b.blur_score * 5
    assert s.low_quality is False
    assert b.low_quality is True
    assert "blur" in b.reasons


def test_dark_frame_is_flagged(dark: Path) -> None:
    q = fq.evaluate_frame(dark, 1.0)
    assert q.brightness < fq.DEFAULT_BRIGHTNESS_RANGE[0]
    assert q.low_quality is True
    assert "too_dark" in q.reasons


def test_brightness_is_within_range_for_normal_frame(sharp: Path) -> None:
    q = fq.evaluate_frame(sharp, 1.0)
    lo, hi = fq.DEFAULT_BRIGHTNESS_RANGE
    assert lo <= q.brightness <= hi


def test_evaluate_frames_returns_one_per_time(sharp: Path) -> None:
    out = fq.evaluate_frames(sharp, [0.2, 0.8, 1.4])
    assert [q.time_s for q in out] == [0.2, 0.8, 1.4]


def test_best_time_around_prefers_sharper_frame(sharp: Path) -> None:
    t, q = fq.best_time_around(sharp, 1.0, window_s=0.5, step_s=0.25)
    assert 0.5 <= t <= 1.5
    assert q.blur_score > 0


def test_missing_video_raises(tmp_path: Path) -> None:
    with pytest.raises(fq.FrameQualityError):
        fq.evaluate_frame(tmp_path / "nope.mp4", 1.0)


def test_laplacian_variance_of_flat_image_is_zero() -> None:
    flat = bytes([128] * (32 * 32))
    assert fq.laplacian_variance(flat, 32, 32) == pytest.approx(0.0, abs=1e-9)


def test_laplacian_variance_detects_edges() -> None:
    # 左半分が黒、右半分が白 → 境界でラプラシアンが立つ
    rows = []
    for _y in range(32):
        rows.append(bytes([0] * 16 + [255] * 16))
    data = b"".join(rows)
    assert fq.laplacian_variance(data, 32, 32) > 100.0


def test_mean_brightness() -> None:
    assert fq.mean_brightness(bytes([100] * 10)) == pytest.approx(100.0)
    assert fq.mean_brightness(b"") == 0.0
