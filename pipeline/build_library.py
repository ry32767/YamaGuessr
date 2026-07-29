#!/usr/bin/env python3
"""出題に使う画像の一覧（ライブラリ）を作る。

動画も写真も、**位置は推定せずただの画像として** 集める。どの画像をどの地点に
使うかは `review.html` で人が選ぶ（GPXの時刻は計画のことがあり、撮影時刻から
位置を割り出す方法は当てにならないため。docs/spec.md の設計判断表）。

- 動画：一定間隔（既定2秒）でフレームを抜き出す
- 写真：そのまま取り込む。EXIFの撮影日時が読めれば並び順に使う

出すのは**閲覧用の小さなJPEG**と索引。出題に使う画像は、地点が確定してから
`extract_frames.py final` が原本から作り直す。

使い方::

    python pipeline/build_library.py \\
        --video clip=Source/DJI_xxx.MP4 --photos-dir Source/photos \\
        --out-dir pipeline/data/library --interval-s 2
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

from exif import ExifError, JPEG_SUFFIXES, TIFF_SUFFIXES, UNSUPPORTED_SUFFIXES, read_exif

#: 動画から何秒おきに抜き出すか
DEFAULT_INTERVAL_S = 2.0
#: 閲覧用画像の長辺 [px]
PREVIEW_LONG_EDGE = 480

PHOTO_SUFFIXES = JPEG_SUFFIXES | TIFF_SUFFIXES


class LibraryError(RuntimeError):
    """ライブラリを作れない。"""


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def parse_video_args(values: Optional[Sequence[str]]) -> dict[str, str]:
    """``--video path`` / ``--video media_id=path`` を辞書にする。"""
    out: dict[str, str] = {}
    for v in values or []:
        if "=" in v:
            media_id, path = v.split("=", 1)
            out[media_id] = path
        else:
            out[Path(v).stem] = v
    return out


def video_duration_s(path: str) -> float:
    """ffprobe で動画の長さを得る。"""
    if not shutil.which("ffprobe"):
        raise LibraryError("ffprobe が見つかりません")
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise LibraryError(f"{path} の長さを取得できませんでした")
    try:
        return float(proc.stdout.strip())
    except ValueError as e:
        raise LibraryError(f"{path} の長さを解釈できませんでした") from e


def sample_video(media_id: str, video: str, out_dir: Path,
                 interval_s: float = DEFAULT_INTERVAL_S,
                 long_edge: int = PREVIEW_LONG_EDGE) -> list[dict[str, Any]]:
    """動画を一定間隔で抜き出し、ライブラリ項目のリストを返す。"""
    if not ffmpeg_available():
        raise LibraryError("ffmpeg が見つかりません")
    duration = video_duration_s(video)
    out_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, Any]] = []
    t = 0.0
    index = 0
    while t < duration:
        name = f"{media_id}-{index:05d}.jpg"
        dest = out_dir / name
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", video,
             "-frames:v", "1", "-vf", f"scale='min({long_edge},iw)':-2",
             "-q:v", "5", "-map_metadata", "-1", str(dest)],
            capture_output=True, check=False)
        if proc.returncode == 0 and dest.exists():
            entries.append({
                "id": f"{media_id}-{index:05d}",
                "kind": "video_frame",
                "media_id": media_id,
                "source": Path(video).name,
                "source_path": video,
                "time_s": round(t, 3),
                "file": name,
                "order": t,
            })
        t += interval_s
        index += 1
    return entries


def collect_photos(photos_dir: Path, out_dir: Path,
                   long_edge: int = PREVIEW_LONG_EDGE) -> tuple[list[dict[str, Any]],
                                                                list[str]]:
    """写真を取り込み、(ライブラリ項目, 読めなかったファイル名) を返す。"""
    if not photos_dir.exists():
        return [], []
    if not ffmpeg_available():
        raise LibraryError("ffmpeg が見つかりません")
    out_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, Any]] = []
    unsupported: list[str] = []
    for path in sorted(photos_dir.iterdir()):
        if not path.is_file():
            continue
        if path.suffix in UNSUPPORTED_SUFFIXES:
            unsupported.append(path.name)
            continue
        if path.suffix not in PHOTO_SUFFIXES:
            continue
        entry_id = f"photo-{path.stem}"
        name = f"{entry_id}.jpg"
        dest = out_dir / name
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(path),
             "-vf", f"scale='min({long_edge},iw)':-2", "-q:v", "5",
             "-map_metadata", "-1", str(dest)],
            capture_output=True, check=False)
        if proc.returncode != 0 or not dest.exists():
            continue
        taken: Optional[str] = None
        try:
            info = read_exif(path)
            if info.taken_local is not None:
                taken = info.taken_local.isoformat()
        except ExifError:
            taken = None
        entries.append({
            "id": entry_id,
            "kind": "photo",
            "source": path.name,
            "source_path": str(path).replace("\\", "/"),
            "photo_source": path.name,
            "taken_local": taken,
            "file": name,
            # 撮影日時が読めれば時系列、無ければ名前順で並べる
            "order": taken or path.name,
        })
    return entries, unsupported


def run(videos: dict[str, str], photos_dir: Optional[str], out_dir: str,
        interval_s: float = DEFAULT_INTERVAL_S, quiet: bool = False) -> dict[str, Any]:
    """ライブラリを作って索引を書き出す。"""
    root = Path(out_dir)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, Any]] = []
    for media_id, video in videos.items():
        if not Path(video).exists():
            raise LibraryError(f"{video} がありません")
        found = sample_video(media_id, video, root, interval_s)
        entries.extend(found)
        if not quiet:
            print(f"動画 {Path(video).name}: {len(found)}枚（{interval_s}秒おき）")

    unsupported: list[str] = []
    if photos_dir:
        photos, unsupported = collect_photos(Path(photos_dir), root)
        entries.extend(photos)
        if not quiet and photos:
            print(f"写真: {len(photos)}枚")

    if not entries:
        raise LibraryError(
            "画像が1枚もできませんでした。動画か写真を指定してください")

    # 動画はメディアごとに時刻順、写真は撮影日時順。まとめて安定した順に並べる
    entries.sort(key=lambda e: (e["kind"], e.get("media_id", ""), str(e["order"])))
    for e in entries:
        e.pop("order", None)

    meta = {
        "count": len(entries),
        "video_frames": sum(1 for e in entries if e["kind"] == "video_frame"),
        "photos": sum(1 for e in entries if e["kind"] == "photo"),
        "interval_s": interval_s,
        "unsupported": unsupported,
    }
    (root / "index.json").write_text(
        json.dumps({"meta": meta, "images": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8")

    if not quiet:
        print(f"ライブラリ: {len(entries)}枚 → {root}")
        if unsupported:
            print(f"注意: HEIC/HEIF {len(unsupported)}枚は読めません"
                  "（JPEGに変換してください）", file=sys.stderr)
    return meta


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="出題に使う画像の一覧を作る")
    ap.add_argument("--video", action="append",
                    help="'path' か 'media_id=path'（複数可）")
    ap.add_argument("--photos-dir", help="写真の置き場（既定 Source/photos）")
    ap.add_argument("--out-dir", default="pipeline/data/library")
    ap.add_argument("--interval-s", type=float, default=DEFAULT_INTERVAL_S,
                    help="動画から何秒おきに抜き出すか")
    args = ap.parse_args(argv)
    try:
        run(parse_video_args(args.video), args.photos_dir, args.out_dir,
            args.interval_s)
    except (LibraryError, OSError, ValueError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
