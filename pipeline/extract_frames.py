#!/usr/bin/env python3
"""動画から出題用のフレームを切り出す（機能D）。

2つのモードがある。

``previews``
    レビュー用。各候補の前後±5秒を0.5秒刻みで低解像度JPEGに落とす。
    `review.html` で切り出し時刻を調整しながら見るために先に一括生成しておく。
``final``
    本番用。`confirmed_points.json` の確定時刻から長辺1280pxのWebPを作る。
    **メタデータは全除去**（`-map_metadata -1`）し、ファイル名に緯度経度を含めない。

使い方::

    python pipeline/extract_frames.py previews \\
        --candidates pipeline/data/candidates.json \\
        --video clip=Source/DJI_xxx.MP4 \\
        --out-dir pipeline/data/previews

    python pipeline/extract_frames.py final \\
        --confirmed pipeline/data/confirmed_points.json \\
        --video clip=Source/DJI_xxx.MP4 \\
        --out-dir public/images/odaigahara-2026-06-11
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

#: レビューで時刻調整できる範囲と刻み（docs/spec.md 機能C）
PREVIEW_WINDOW_S = 5.0
PREVIEW_STEP_S = 0.5
#: プレビューの長辺 [px]
PREVIEW_LONG_EDGE = 480
#: 本番画像の長辺 [px] と上限サイズ [byte]
FINAL_LONG_EDGE = 1280
FINAL_MAX_BYTES = 200 * 1024
#: WebP品質の探索順（上限サイズに収まるまで落とす）
QUALITY_LADDER = (82, 72, 62, 52, 42)


class FrameExtractError(RuntimeError):
    """フレームを切り出せなかった。"""


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _require_ffmpeg() -> None:
    if not ffmpeg_available():
        raise FrameExtractError("ffmpeg が見つかりません")


def parse_video_args(values: Optional[Sequence[str]]) -> dict[str, str]:
    """``--video path`` / ``--video media_id=path`` を辞書にする。"""
    out: dict[str, str] = {}
    for v in values or []:
        if "=" in v:
            media_id, path = v.split("=", 1)
            out[media_id] = path
        else:
            out["*"] = v
    return out


def resolve_video(videos: dict[str, str], media_id: Optional[str]) -> Optional[str]:
    return videos.get(media_id or "") or videos.get("*")


def _run_ffmpeg(cmd: Sequence[str], what: str) -> None:
    proc = subprocess.run(list(cmd), capture_output=True, check=False)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise FrameExtractError(f"{what} に失敗しました: {err}")


# ---------------------------------------------------------------------------
# プレビュー（レビュー用）
# ---------------------------------------------------------------------------
def preview_offsets(window_s: float = PREVIEW_WINDOW_S,
                    step_s: float = PREVIEW_STEP_S) -> list[float]:
    """-window_s 〜 +window_s を step_s 刻みにしたオフセット列。"""
    steps = int(round(window_s / step_s))
    return [round(i * step_s, 3) for i in range(-steps, steps + 1)]


def offset_key(offset_s: float) -> str:
    """オフセットをファイル名に使える文字列にする（-0.5 → 'm0_5'）。"""
    sign = "m" if offset_s < 0 else "p"
    return f"{sign}{abs(offset_s):.1f}".replace(".", "_")


def extract_preview_set(video: str, base_time_s: float, out_dir: Path,
                        window_s: float = PREVIEW_WINDOW_S,
                        step_s: float = PREVIEW_STEP_S,
                        long_edge: int = PREVIEW_LONG_EDGE) -> list[dict[str, Any]]:
    """1候補ぶんのプレビュー画像を書き出し、(オフセット, ファイル名) を返す。"""
    _require_ffmpeg()
    out_dir.mkdir(parents=True, exist_ok=True)
    made: list[dict[str, Any]] = []
    for off in preview_offsets(window_s, step_s):
        t = base_time_s + off
        if t < 0:
            continue
        name = f"{offset_key(off)}.jpg"
        path = out_dir / name
        try:
            _run_ffmpeg([
                "ffmpeg", "-v", "error", "-y",
                "-ss", f"{t:.3f}", "-i", video,
                "-frames:v", "1",
                "-vf", f"scale='min({long_edge},iw)':-2",
                "-q:v", "5", "-map_metadata", "-1",
                str(path),
            ], f"プレビュー({t:.2f}s)")
        except FrameExtractError:
            continue  # 動画末尾を超えた等。その時刻は選べないだけ
        if path.exists():
            made.append({"offset_s": off, "time_s": round(t, 3), "file": name})
    return made


def build_previews(candidates_path: str, videos: dict[str, str], out_dir: str,
                   window_s: float = PREVIEW_WINDOW_S,
                   step_s: float = PREVIEW_STEP_S,
                   quiet: bool = False) -> dict[str, Any]:
    """candidates.json の各候補についてプレビューを一括生成し、索引を書き出す。"""
    data = json.loads(Path(candidates_path).read_text(encoding="utf-8"))
    candidates = data.get("candidates", [])
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)

    index: dict[str, Any] = {}
    skipped = 0
    for c in candidates:
        if "frame_time_s" not in c:
            skipped += 1
            continue
        video = resolve_video(videos, c.get("media_id"))
        if not video:
            skipped += 1
            continue
        frames = extract_preview_set(video, float(c["frame_time_s"]),
                                     root / c["id"], window_s, step_s)
        if frames:
            index[c["id"]] = {"base_time_s": c["frame_time_s"],
                              "media_id": c.get("media_id"),
                              "frames": frames}
        if not quiet and len(index) % 10 == 0 and index:
            print(f"  ... {len(index)} 候補ぶん生成", file=sys.stderr)

    meta = {"candidates": len(candidates), "with_previews": len(index),
            "skipped": skipped, "window_s": window_s, "step_s": step_s}
    (root / "index.json").write_text(
        json.dumps({"meta": meta, "previews": index}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    if not quiet:
        print(f"プレビュー: {len(index)}候補ぶん（対象外 {skipped}件）→ {root}")
        if skipped and not index:
            print("注意: 切り出し時刻を持つ候補がありません"
                  "（GPXのみで検出した候補は3Dビュー専用です）", file=sys.stderr)
    return meta


# ---------------------------------------------------------------------------
# 本番画像
# ---------------------------------------------------------------------------
def extract_final_frame(video: str, time_s: float, out_path: Path,
                        long_edge: int = FINAL_LONG_EDGE,
                        max_bytes: int = FINAL_MAX_BYTES) -> dict[str, Any]:
    """確定時刻のフレームをWebPで書き出す。上限サイズに収まるまで品質を落とす。"""
    _require_ffmpeg()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    last_size = 0
    for quality in QUALITY_LADDER:
        _run_ffmpeg([
            "ffmpeg", "-v", "error", "-y",
            "-ss", f"{time_s:.3f}", "-i", video,
            "-frames:v", "1",
            # 長辺を long_edge に合わせる（縦長でも横長でも）
            "-vf", f"scale='if(gte(iw,ih),min({long_edge},iw),-2)':"
                   f"'if(gte(iw,ih),-2,min({long_edge},ih))'",
            "-c:v", "libwebp", "-quality", str(quality),
            # 位置情報などを漏らさないためメタデータを全除去する
            "-map_metadata", "-1",
            str(out_path),
        ], f"フレーム切り出し({time_s:.2f}s)")
        last_size = out_path.stat().st_size
        if last_size <= max_bytes:
            return {"bytes": last_size, "quality": quality}
    raise FrameExtractError(
        f"{out_path.name} が上限 {max_bytes}B に収まりません（最小 {last_size}B）")


def build_final_frames(confirmed_path: str, videos: dict[str, str], out_dir: str,
                       long_edge: int = FINAL_LONG_EDGE,
                       max_bytes: int = FINAL_MAX_BYTES,
                       quiet: bool = False) -> dict[str, Any]:
    """confirmed_points.json の確定時刻から本番画像を作る。"""
    data = json.loads(Path(confirmed_path).read_text(encoding="utf-8"))
    points = data.get("points", data if isinstance(data, list) else [])
    root = Path(out_dir)

    written: list[dict[str, Any]] = []
    frameless = 0
    for p in points:
        if p.get("frame_time_s") is None:
            frameless += 1
            continue
        video = resolve_video(videos, p.get("media_id"))
        if not video:
            frameless += 1
            continue
        # ファイル名に緯度経度を含めない（point_id のみ）
        out_path = root / f"{p['id']}.webp"
        info = extract_final_frame(video, float(p["frame_time_s"]), out_path,
                                   long_edge, max_bytes)
        written.append({"id": p["id"], "file": out_path.name, **info})
        if not quiet and len(written) % 10 == 0:
            print(f"  ... {len(written)}枚", file=sys.stderr)

    meta = {"points": len(points), "images_written": len(written),
            "frameless": frameless, "out_dir": str(root),
            "long_edge": long_edge, "max_bytes": max_bytes}
    if written:
        meta["max_written_bytes"] = max(w["bytes"] for w in written)
    if not quiet:
        print(f"本番画像: {len(written)}枚 → {root}"
              + (f"（画像なし地点 {frameless}件は3Dビュー専用）" if frameless else ""))
    return meta


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="動画からフレームを切り出す")
    sub = ap.add_subparsers(dest="mode", required=True)

    pv = sub.add_parser("previews", help="レビュー用の低解像度プレビューを一括生成")
    pv.add_argument("--candidates", required=True)
    pv.add_argument("--video", action="append", required=True,
                    help="'path' か 'media_id=path'（複数可）")
    pv.add_argument("--out-dir", default="pipeline/data/previews")
    pv.add_argument("--window-s", type=float, default=PREVIEW_WINDOW_S)
    pv.add_argument("--step-s", type=float, default=PREVIEW_STEP_S)

    fn = sub.add_parser("final", help="確定時刻から本番用WebPを書き出す")
    fn.add_argument("--confirmed", required=True)
    fn.add_argument("--video", action="append", required=True)
    fn.add_argument("--out-dir", required=True)
    fn.add_argument("--long-edge", type=int, default=FINAL_LONG_EDGE)
    fn.add_argument("--max-bytes", type=int, default=FINAL_MAX_BYTES)

    args = ap.parse_args(argv)
    try:
        videos = parse_video_args(args.video)
        if args.mode == "previews":
            build_previews(args.candidates, videos, args.out_dir,
                           args.window_s, args.step_s)
        else:
            build_final_frames(args.confirmed, videos, args.out_dir,
                               args.long_edge, args.max_bytes)
    except (FrameExtractError, OSError, ValueError, json.JSONDecodeError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
