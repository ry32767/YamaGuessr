"""動画フレームの品質（ブレ・明るさ）を測る（機能B の品質ゲート）。

アクションカメラのフレームは地面向き・ブレ・逆光が普通に混ざるため、
これが無いと出題不能な画像が候補に紛れ込む。

ffmpeg で 1 フレームだけをグレースケールの生バイト列として取り出し、
ラプラシアン分散（ブレ）と平均輝度を純Pythonで計算する。
画像ライブラリには依存しない。
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable, NamedTuple, Optional

#: 解析用に縮小する幅 [px]。小さくしても相対的なブレ量は保たれる
ANALYSIS_WIDTH = 320
#: ラプラシアン分散がこれ未満ならブレ・ピンボケとみなす（最低ライン）。
#: 絶対値はカメラ・被写体で桁が変わるため、実運用では
#: detect_candidates.py 側で「その動画の中央値に対する相対値」と併用する。
#: 実測：Osmo Action 6 の 4K実写で 1500〜2500、boxblur を掛けた合成映像で 20 前後。
DEFAULT_BLUR_THRESHOLD = 60.0
#: その動画のブレ値の中央値に対して、この割合を下回ったら low_quality
DEFAULT_BLUR_RELATIVE_FACTOR = 0.35
#: 平均輝度がこの範囲を外れたら暗すぎ／白飛びとみなす（0〜255）
DEFAULT_BRIGHTNESS_RANGE = (35.0, 225.0)


class FrameQualityError(RuntimeError):
    """フレームを取り出せなかった。"""


class FrameQuality(NamedTuple):
    time_s: float
    blur_score: float
    """ラプラシアン分散。大きいほどシャープ"""
    brightness: float
    """平均輝度（0〜255）"""
    low_quality: bool
    reasons: tuple[str, ...]


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def grab_gray_frame(video: str | Path, time_s: float,
                    width: int = ANALYSIS_WIDTH) -> tuple[bytes, int, int]:
    """指定時刻のフレームをグレースケール生バイトで取り出す。

    :return: (画素バイト列, 幅, 高さ)
    """
    if not ffmpeg_available():
        raise FrameQualityError("ffmpeg が見つかりません")
    cmd = [
        "ffmpeg", "-v", "error",
        "-ss", f"{max(0.0, time_s):.3f}",
        "-i", str(video),
        "-frames:v", "1",
        "-vf", f"scale={width}:-2",
        "-pix_fmt", "gray",
        "-f", "rawvideo", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise FrameQualityError(
            f"{video} の {time_s:.3f}s のフレームを取り出せませんでした: {err}")
    data = proc.stdout
    if len(data) % width != 0:
        raise FrameQualityError("取り出したフレームのサイズが想定と違います")
    return data, width, len(data) // width


def laplacian_variance(data: bytes, width: int, height: int) -> float:
    """4近傍ラプラシアンの分散。ブレ・ピンボケの指標。"""
    if width < 3 or height < 3:
        return 0.0
    total = 0.0
    total_sq = 0.0
    count = 0
    for y in range(1, height - 1):
        row = y * width
        up = row - width
        down = row + width
        for x in range(1, width - 1):
            i = row + x
            lap = (data[i - 1] + data[i + 1] + data[up + x] + data[down + x]
                   - 4 * data[i])
            total += lap
            total_sq += lap * lap
            count += 1
    if count == 0:
        return 0.0
    mean = total / count
    return total_sq / count - mean * mean


def mean_brightness(data: bytes) -> float:
    return sum(data) / len(data) if data else 0.0


def evaluate_frame(video: str | Path, time_s: float,
                   blur_threshold: float = DEFAULT_BLUR_THRESHOLD,
                   brightness_range: tuple[float, float] = DEFAULT_BRIGHTNESS_RANGE
                   ) -> FrameQuality:
    """1フレームの品質を測る。"""
    data, w, h = grab_gray_frame(video, time_s)
    blur = laplacian_variance(data, w, h)
    bright = mean_brightness(data)
    reasons: list[str] = []
    if blur < blur_threshold:
        reasons.append("blur")
    if bright < brightness_range[0]:
        reasons.append("too_dark")
    elif bright > brightness_range[1]:
        reasons.append("too_bright")
    return FrameQuality(round(time_s, 3), round(blur, 2), round(bright, 2),
                        bool(reasons), tuple(reasons))


def evaluate_frames(video: str | Path, times_s: Iterable[float],
                    blur_threshold: float = DEFAULT_BLUR_THRESHOLD,
                    brightness_range: tuple[float, float] = DEFAULT_BRIGHTNESS_RANGE
                    ) -> list[FrameQuality]:
    return [evaluate_frame(video, t, blur_threshold, brightness_range)
            for t in times_s]


def best_time_around(video: str | Path, time_s: float,
                     window_s: float = 5.0, step_s: float = 0.5
                     ) -> tuple[float, FrameQuality]:
    """前後 ``window_s`` で最もシャープなフレームの時刻を探す。

    レビュー時の時刻調整（±5秒・0.5秒刻み）の初期値に使う。
    """
    best: Optional[tuple[float, FrameQuality]] = None
    t = max(0.0, time_s - window_s)
    end = time_s + window_s
    while t <= end:
        try:
            q = evaluate_frame(video, t)
        except FrameQualityError:
            t += step_s
            continue
        if best is None or q.blur_score > best[1].blur_score:
            best = (t, q)
        t += step_s
    if best is None:
        raise FrameQualityError(f"{video} の {time_s}s 付近でフレームを取得できませんでした")
    return best
