#!/usr/bin/env python3
"""スマホなどで撮った写真を出題地点にする。

写真1枚 ＝ 出題地点1つ。位置は **EXIFの撮影日時をGPXに突き合わせて** 決める
（写真のGPSより、GPXの方が精度も一貫性も高いため。docs/spec.md の設計判断表）。
画像は長辺1280pxのWebPに変換し、**メタデータを全除去**して書き出す。

使い方::

    python pipeline/import_photos.py --gpx Source/route.gpx \\
        --photos-dir Source/photos \\
        --mountain-id odaigahara-2026-06-11 --mountain-name "大台ヶ原・日出ヶ岳" \\
        --out pipeline/data/confirmed_points.json \\
        --images-out pipeline/data/frames
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

from exif import ExifError, JPEG_SUFFIXES, TIFF_SUFFIXES, UNSUPPORTED_SUFFIXES, read_exif
from geo import LatLon, bearing_deg, haversine_m
from gpx import GpxTrack, load_gpx

#: 出力画像の長辺 [px] と上限サイズ [byte]（extract_frames.py と揃える）
LONG_EDGE = 1280
MAX_BYTES = 200 * 1024
QUALITY_LADDER = (82, 72, 62, 52, 42)
#: 既定のタイムゾーン（EXIFにオフセットが無いとき）
DEFAULT_TZ = "+09:00"
#: GPXの時刻範囲からこれ以上外れた写真は採用しない [秒]
DEFAULT_TIME_GAP_LIMIT_S = 300.0

PHOTO_SUFFIXES = JPEG_SUFFIXES | TIFF_SUFFIXES


class ImportError_(RuntimeError):
    """写真を取り込めない。"""


def list_photos(photos_dir: str | Path) -> tuple[list[Path], list[Path]]:
    """(読める写真, 読めない形式) を返す。"""
    root = Path(photos_dir)
    if not root.exists():
        raise ImportError_(f"{root} がありません")
    usable: list[Path] = []
    unsupported: list[Path] = []
    for path in sorted(root.iterdir()):
        if not path.is_file():
            continue
        if path.suffix in PHOTO_SUFFIXES:
            usable.append(path)
        elif path.suffix in UNSUPPORTED_SUFFIXES:
            unsupported.append(path)
    return usable, unsupported


def parse_tz_minutes(text: str) -> int:
    """"+09:00" を分に直す。"""
    try:
        dt = datetime.fromisoformat(f"2000-01-01T00:00:00{text}")
    except ValueError as e:
        raise ImportError_(f"タイムゾーンの指定が不正です: {text}") from e
    delta = dt.utcoffset()
    if delta is None:
        raise ImportError_(f"タイムゾーンの指定が不正です: {text}")
    return int(delta.total_seconds() // 60)


def convert_photo(src: Path, dest: Path, long_edge: int = LONG_EDGE,
                  max_bytes: int = MAX_BYTES) -> dict[str, Any]:
    """写真をWebPに変換する。メタデータは全除去する（位置情報を漏らさない）。"""
    if not shutil.which("ffmpeg"):
        raise ImportError_("ffmpeg が見つかりません")
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_size = 0
    for quality in QUALITY_LADDER:
        cmd = [
            "ffmpeg", "-v", "error", "-y", "-i", str(src),
            "-vf", f"scale='if(gte(iw,ih),min({long_edge},iw),-2)':"
                   f"'if(gte(iw,ih),-2,min({long_edge},ih))'",
            "-c:v", "libwebp", "-quality", str(quality),
            "-map_metadata", "-1",
            str(dest),
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()
            raise ImportError_(f"{src.name} を変換できませんでした: {err}")
        last_size = dest.stat().st_size
        if last_size <= max_bytes:
            return {"bytes": last_size, "quality": quality}
    raise ImportError_(
        f"{dest.name} が上限 {max_bytes}B に収まりません（最小 {last_size}B）")


def locate(track: GpxTrack, when_utc: datetime,
           fallback: Optional[tuple[float, float]]) -> tuple[LatLon, float, str]:
    """撮影時刻からGPX上の位置を決める。

    :return: (座標, 最寄りトラックポイントとの時間差[秒], 決め方)
    """
    if track.has_time:
        pos, gap = track.position_at(when_utc)
        return pos, gap, "time"
    if fallback is not None:
        # GPXに時刻が無ければ、写真のGPSをルートにスナップして使う
        snapped = track.polyline.snap(fallback[0], fallback[1])
        return LatLon(snapped.lat, snapped.lon), 0.0, "photo_gps_snap"
    raise ImportError_(
        "GPXに時刻が無く、写真にもGPSがありません。位置を決められません")


def heading_at(track: GpxTrack, position: LatLon, ahead_m: float = 30.0) -> Optional[float]:
    """その位置でのルートの進行方位。3Dビューの初期の向きに使う。"""
    snapped = track.polyline.snap(position.lat, position.lon)
    forward = track.polyline.point_at(min(snapped.along_m + ahead_m,
                                          track.polyline.length_m))
    if haversine_m(position, forward) < 1.0:
        return None
    return round(bearing_deg(position, forward), 2)


def import_photos(gpx_path: str, photos_dir: str, mountain_id: str, mountain_name: str,
                  images_out: str, tz: str = DEFAULT_TZ,
                  time_offset_s: float = 0.0,
                  time_gap_limit_s: float = DEFAULT_TIME_GAP_LIMIT_S,
                  quiet: bool = False) -> dict[str, Any]:
    """写真を確定地点の構造に変換し、画像を書き出す。"""
    track = load_gpx(gpx_path)
    tz_minutes = parse_tz_minutes(tz)
    photos, unsupported = list_photos(photos_dir)
    if not photos:
        raise ImportError_(
            f"{photos_dir} に読める写真がありません"
            + ("（HEICはJPEGに変換してください）" if unsupported else ""))

    images_dir = Path(images_out)
    points: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    seq = 0

    for photo in photos:
        try:
            exif = read_exif(photo)
        except ExifError as e:
            skipped.append({"file": photo.name, "reason": str(e)})
            continue
        when = exif.taken_utc(tz_minutes)
        if when is None:
            skipped.append({"file": photo.name, "reason": "撮影日時が読めません"})
            continue
        when += timedelta(seconds=time_offset_s)

        fallback = (exif.lat, exif.lon) if exif.lat is not None and exif.lon is not None else None
        try:
            position, gap, method = locate(track, when, fallback)
        except ImportError_ as e:
            skipped.append({"file": photo.name, "reason": str(e)})
            continue
        if method == "time" and gap > time_gap_limit_s:
            skipped.append({
                "file": photo.name,
                "reason": f"GPXの時刻範囲から{int(gap)}秒外れています（別の山行の写真？）",
            })
            continue

        seq += 1
        point_id = f"{mountain_id}-p{seq:03d}"
        info = convert_photo(photo, images_dir / f"{point_id}.webp")
        point: dict[str, Any] = {
            "id": point_id,
            "type": "photo",
            "lat": round(position.lat, 7),
            "lon": round(position.lon, 7),
            "source": "manual",
            "photo_source": photo.name,
            "real_time": when.isoformat(),
            "match_method": method,
            "image_bytes": info["bytes"],
        }
        heading = heading_at(track, position)
        if heading is not None:
            point["heading_route_deg"] = heading
        elevation = _elevation_at(track, position)
        if elevation is not None:
            point["elevation_m"] = elevation
        points.append(point)

    if not points:
        raise ImportError_("取り込めた写真が1枚もありません")

    points.sort(key=lambda p: p["real_time"])
    for i, point in enumerate(points, start=1):
        point["id"] = f"{mountain_id}-p{i:03d}"

    confirmed = {
        "mountain": {"id": mountain_id, "name": mountain_name},
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reviewed": False,
        "points": points,
    }
    meta = {
        "imported": len(points),
        "skipped": skipped,
        "unsupported": [p.name for p in unsupported],
        "images_dir": str(images_dir),
    }
    if not quiet:
        print(f"写真 {len(points)}枚を取り込みました → {images_dir}")
        for s in skipped:
            print(f"  スキップ {s['file']}: {s['reason']}", file=sys.stderr)
        if unsupported:
            print(f"  HEIC/HEIF {len(unsupported)}枚は読めません"
                  "（JPEGに変換してください）", file=sys.stderr)
    return {"confirmed": confirmed, "meta": meta}


def _elevation_at(track: GpxTrack, position: LatLon) -> Optional[float]:
    """GPXの標高から、その位置のおよその標高を拾う。"""
    best: Optional[float] = None
    best_d = float("inf")
    for p in track.points:
        if p.ele is None:
            continue
        d = haversine_m(position, LatLon(p.lat, p.lon))
        if d < best_d:
            best_d = d
            best = p.ele
    return round(best, 1) if best is not None else None


def run(gpx: str, photos_dir: str, mountain_id: str, mountain_name: str,
        out_path: str, images_out: str, tz: str = DEFAULT_TZ,
        time_offset_s: float = 0.0,
        time_gap_limit_s: float = DEFAULT_TIME_GAP_LIMIT_S,
        quiet: bool = False) -> dict[str, Any]:
    result = import_photos(gpx, photos_dir, mountain_id, mountain_name, images_out,
                           tz, time_offset_s, time_gap_limit_s, quiet)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result["confirmed"], ensure_ascii=False, indent=1),
                   encoding="utf-8")
    if not quiet:
        print(f"書き出し: {out}")
    return result["meta"]


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="写真から出題地点を作る")
    ap.add_argument("--gpx", required=True)
    ap.add_argument("--photos-dir", required=True)
    ap.add_argument("--mountain-id", required=True)
    ap.add_argument("--mountain-name", required=True)
    ap.add_argument("--out", default="pipeline/data/confirmed_points.json")
    ap.add_argument("--images-out", default="pipeline/data/frames")
    ap.add_argument("--tz", default=DEFAULT_TZ,
                    help="EXIFにオフセットが無いときのタイムゾーン")
    ap.add_argument("--time-offset-s", type=float, default=0.0,
                    help="カメラ時計とGPXの時計のずれ補正 [秒]")
    ap.add_argument("--time-gap-limit-s", type=float, default=DEFAULT_TIME_GAP_LIMIT_S)
    args = ap.parse_args(argv)
    try:
        run(args.gpx, args.photos_dir, args.mountain_id, args.mountain_name,
            args.out, args.images_out, args.tz, args.time_offset_s,
            args.time_gap_limit_s)
    except (ImportError_, ExifError, ValueError, OSError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
