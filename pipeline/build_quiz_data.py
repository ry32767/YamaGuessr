#!/usr/bin/env python3
"""確定地点から公開用の `quiz_points.json` を作る（機能D・E）。

**公開JSONに出すのはGPX由来の座標だけ**。生GPS・`snap_distance_m`・
品質スコアなどの中間情報は `pipeline/data/` に留める（docs/data-model.md）。

使い方::

    python pipeline/build_quiz_data.py \\
        --confirmed pipeline/data/confirmed_points.json \\
        --gpx Source/route.gpx \\
        --images-dir pipeline/data/frames \\
        --public-dir public

既存の `public/data/quiz_points.json` があれば `mountain_id` 単位でマージする
（別の山を後から足しても既存データを壊さない）。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

from geo import LatLon, haversine_m, simplify
from gpx import load_gpx

#: max_distance_m = GPXルートのバウンディングボックス対角線 × この係数（厳しめ）
DEFAULT_MAX_DISTANCE_FACTOR = 0.5
#: 配信用トラックの簡略化の許容誤差 [m]。地形図の縮尺では元の線と区別がつかない
DEFAULT_TRACK_TOLERANCE_M = 8.0
#: スコア減衰の急峻さ（既定4、大きいほど厳しい）
DEFAULT_SCORING_K = 4.0
#: max_distance_m の下限 [m]（ごく短いルートで0点必至にならないように）
MIN_MAX_DISTANCE_M = 200.0

#: 公開するトラックの置き場（public/ からの相対パス）
TRACK_DIR = "data/tracks"

#: 公開JSONに出してよいPointのフィールド（これ以外は落とす）
PUBLIC_POINT_FIELDS = (
    "id", "mountain_id", "lat", "lon", "elevation_m", "type", "image_path",
    "media_id", "frame_time_s", "heading_deg", "heading_route_deg", "source",
)


class BuildError(RuntimeError):
    """出題データを組み立てられない。"""


def dataset_version(now: Optional[datetime] = None) -> str:
    """生成日時ベースの `dataset_version`。進捗の互換性判定に使う。"""
    dt = now or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def max_distance_from_gpx(gpx_path: str | Path,
                          factor: float = DEFAULT_MAX_DISTANCE_FACTOR) -> float:
    """GPXのバウンディングボックス対角線 × 係数。"""
    track = load_gpx(gpx_path)
    return max(MIN_MAX_DISTANCE_M, track.polyline.bbox_diagonal_m() * factor)


def max_distance_from_points(points: Sequence[dict[str, Any]],
                             factor: float = DEFAULT_MAX_DISTANCE_FACTOR) -> float:
    """GPXが無い場合に、地点群の広がりから代用値を出す。"""
    if not points:
        raise BuildError("地点が1つもありません")
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    diagonal = haversine_m(LatLon(min(lats), min(lons)), LatLon(max(lats), max(lons)))
    return max(MIN_MAX_DISTANCE_M, diagonal * factor)


def load_confirmed(path: str | Path) -> dict[str, Any]:
    """review.html が書き出した confirmed_points.json を読む。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    mountain = data.get("mountain")
    if not mountain or not mountain.get("id") or not mountain.get("name"):
        raise BuildError(f"{path} に mountain.id / mountain.name がありません")
    points = data.get("points") or []
    if not points:
        raise BuildError(f"{path} に採用された地点がありません")
    seen: set[str] = set()
    for p in points:
        for key in ("id", "lat", "lon", "type"):
            if key not in p:
                raise BuildError(f"{path} の地点に {key} がありません: {p.get('id')}")
        if p["id"] in seen:
            raise BuildError(f"地点IDが重複しています: {p['id']}")
        seen.add(p["id"])
    return data


def build_points(confirmed: dict[str, Any], images_dir: Optional[Path],
                 public_images_dir: Optional[Path]) -> list[dict[str, Any]]:
    """確定地点を公開用Pointに変換し、必要なら画像をコピーする。

    画像を持つはずの地点（`frame_time_s` がある）で実ファイルが無ければエラー終了する。
    """
    mountain_id = confirmed["mountain"]["id"]
    missing: list[str] = []
    out: list[dict[str, Any]] = []

    for p in confirmed["points"]:
        point: dict[str, Any] = {
            "id": p["id"],
            "mountain_id": mountain_id,
            "lat": round(float(p["lat"]), 7),
            "lon": round(float(p["lon"]), 7),
            "type": p["type"],
            "source": p.get("source", "auto"),
        }
        # elevation_m は地理院DEM由来の公開情報。3Dビューで視点の高さに使う
        for key in ("elevation_m", "media_id", "frame_time_s",
                    "heading_deg", "heading_route_deg"):
            if p.get(key) is not None:
                point[key] = p[key]

        if p.get("frame_time_s") is not None:
            filename = f"{p['id']}.webp"
            src = (images_dir / filename) if images_dir else None
            if src is None or not src.exists():
                missing.append(p["id"])
                continue
            if public_images_dir is not None:
                dest_dir = public_images_dir / mountain_id
                dest_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest_dir / filename)
            point["image_path"] = f"images/{mountain_id}/{filename}"

        out.append({k: point[k] for k in PUBLIC_POINT_FIELDS if k in point})

    if missing:
        raise BuildError(
            "参照画像が見つかりません（先に extract_frames.py final を実行してください）: "
            + ", ".join(missing))
    return out


def write_track(gpx_path: str | Path, public_dir: Path, mountain_id: str,
                tolerance_m: float = DEFAULT_TRACK_TOLERANCE_M) -> dict[str, Any]:
    """GPXを簡略化して、地形図に描くためのGeoJSONを書き出す。

    トラックは山ごとに別ファイルにする。山が増えても quiz_points.json が
    肥大せず、遊ぶ山のぶんだけ読み込めばよいため。
    """
    track = load_gpx(gpx_path)
    raw = [LatLon(p.lat, p.lon) for p in track.points]
    thinned = simplify(raw, tolerance_m)

    rel = f"{TRACK_DIR}/{mountain_id}.json"
    out = public_dir / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    feature = {
        "type": "Feature",
        "properties": {"mountain_id": mountain_id},
        "geometry": {
            "type": "LineString",
            "coordinates": [[round(p.lon, 6), round(p.lat, 6)] for p in thinned],
        },
    }
    out.write_text(json.dumps(feature, ensure_ascii=False), encoding="utf-8")
    return {
        "path": rel,
        "point_count": len(thinned),
        "original_point_count": len(raw),
        "bytes": out.stat().st_size,
    }


def merge_quiz_data(existing: Optional[dict[str, Any]], mountain: dict[str, Any],
                    points: Sequence[dict[str, Any]], version: str) -> dict[str, Any]:
    """既存の quiz_points.json に、この山のぶんを差し替えてマージする。"""
    mountains: list[dict[str, Any]] = []
    all_points: list[dict[str, Any]] = []
    if existing:
        mountains = [m for m in existing.get("mountains", [])
                     if m.get("id") != mountain["id"]]
        all_points = [p for p in existing.get("points", [])
                      if p.get("mountain_id") != mountain["id"]]
    mountains.append(mountain)
    all_points.extend(points)
    mountains.sort(key=lambda m: m["id"])
    all_points.sort(key=lambda p: (p["mountain_id"], p["id"]))
    return {"dataset_version": version, "mountains": mountains, "points": all_points}


def run(confirmed_path: str, gpx: Optional[str] = None,
        images_dir: Optional[str] = None, public_dir: str = "public",
        max_distance_factor: float = DEFAULT_MAX_DISTANCE_FACTOR,
        scoring_k: float = DEFAULT_SCORING_K,
        track_tolerance_m: float = DEFAULT_TRACK_TOLERANCE_M,
        now: Optional[datetime] = None,
        quiet: bool = False) -> dict[str, Any]:
    """quiz_points.json を生成（既存があればマージ）して meta を返す。"""
    confirmed = load_confirmed(confirmed_path)
    public = Path(public_dir)
    data_path = public / "data" / "quiz_points.json"

    points = build_points(
        confirmed,
        Path(images_dir) if images_dir else None,
        public / "images",
    )

    if gpx:
        max_distance_m = max_distance_from_gpx(gpx, max_distance_factor)
    else:
        max_distance_m = max_distance_from_points(points, max_distance_factor)

    mountain: dict[str, Any] = {
        "id": confirmed["mountain"]["id"],
        "name": confirmed["mountain"]["name"],
        "max_distance_m": round(max_distance_m, 1),
        "scoring_k": scoring_k,
    }

    track_info: Optional[dict[str, Any]] = None
    if gpx:
        track_info = write_track(gpx, public, mountain["id"], track_tolerance_m)
        mountain["track_path"] = track_info["path"]

    existing: Optional[dict[str, Any]] = None
    if data_path.exists():
        existing = json.loads(data_path.read_text(encoding="utf-8"))

    version = dataset_version(now)
    merged = merge_quiz_data(existing, mountain, points, version)
    data_path.parent.mkdir(parents=True, exist_ok=True)
    data_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1),
                         encoding="utf-8")

    with_image = sum(1 for p in points if "image_path" in p)
    meta = {
        "out": str(data_path),
        "dataset_version": version,
        "mountain": mountain,
        "point_count": len(points),
        "with_image": with_image,
        "terrain_only": len(points) - with_image,
        "total_mountains": len(merged["mountains"]),
        "total_points": len(merged["points"]),
        "track": track_info,
    }
    if not quiet:
        print(f"山: {mountain['name']}（{mountain['id']}） "
              f"max_distance_m={mountain['max_distance_m']} k={mountain['scoring_k']}")
        print(f"地点: {len(points)}件（画像あり {with_image} / 3D専用 "
              f"{meta['terrain_only']}）")
        if track_info:
            print(f"トラック: {track_info['original_point_count']}点 → "
                  f"{track_info['point_count']}点に簡略化"
                  f"（{track_info['bytes']}B）→ {track_info['path']}")
        else:
            print("注意: --gpx が無いためトラックを出力しません"
                  "（地形図にルートが表示されません）", file=sys.stderr)
        print(f"quiz_points.json: 全{meta['total_mountains']}山 "
              f"{meta['total_points']}地点  version={version}")
        print(f"書き出し: {data_path}")
    return meta


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="公開用 quiz_points.json を作る")
    ap.add_argument("--confirmed", required=True,
                    help="review.html が書き出した confirmed_points.json")
    ap.add_argument("--gpx", help="max_distance_m の算出に使うGPX（省略時は地点の広がりから）")
    ap.add_argument("--images-dir",
                    help="extract_frames.py final の出力ディレクトリ")
    ap.add_argument("--public-dir", default="public")
    ap.add_argument("--max-distance-factor", type=float,
                    default=DEFAULT_MAX_DISTANCE_FACTOR)
    ap.add_argument("--scoring-k", type=float, default=DEFAULT_SCORING_K)
    ap.add_argument("--track-tolerance-m", type=float,
                    default=DEFAULT_TRACK_TOLERANCE_M,
                    help="地形図に描くトラックの簡略化の許容誤差")
    args = ap.parse_args(argv)
    try:
        run(args.confirmed, args.gpx, args.images_dir, args.public_dir,
            args.max_distance_factor, args.scoring_k, args.track_tolerance_m)
    except (BuildError, ValueError, OSError, json.JSONDecodeError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
