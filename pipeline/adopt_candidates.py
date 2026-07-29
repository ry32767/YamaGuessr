#!/usr/bin/env python3
"""候補をまとめて採用して `confirmed_points.json` にする。

本来は `review.html` で人間が1つずつ採否を決める工程（機能C）。
動画がまだ無くて3D専用地点として出すときなど、**レビューを省いて一気に
出題データにしたい**場合の近道として用意している。

使い方::

    python pipeline/adopt_candidates.py \\
        --candidates pipeline/data/candidates.json \\
        --mountain-id odaigahara-2026-06-11 \\
        --mountain-name "大台ヶ原・日出ヶ岳" \\
        --out pipeline/data/confirmed_points.json
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

#: 確定地点に引き継ぐフィールド
CARRY_FIELDS = ("elevation_m", "media_id", "frame_time_s",
                "heading_deg", "heading_route_deg")


class AdoptError(RuntimeError):
    """採用できない。"""


def adopt(candidates_path: str | Path, mountain_id: str, mountain_name: str,
          types: Optional[Sequence[str]] = None,
          min_score: float = 0.0,
          skip_low_quality: bool = True,
          limit: Optional[int] = None) -> dict[str, Any]:
    """候補を絞り込んで確定地点の構造にする。"""
    data = json.loads(Path(candidates_path).read_text(encoding="utf-8"))
    candidates = data.get("candidates", [])
    if not candidates:
        raise AdoptError(f"{candidates_path} に候補がありません")

    picked = [
        c for c in candidates
        if (types is None or c["type"] in types)
        and c.get("score", 0) >= min_score
        and not (skip_low_quality and c.get("low_quality"))
    ]
    picked.sort(key=lambda c: c.get("route_distance_m", 0))
    if limit is not None:
        picked = picked[:limit]
    if not picked:
        raise AdoptError("条件に合う候補が1つもありません")

    points: list[dict[str, Any]] = []
    for i, c in enumerate(picked, start=1):
        point: dict[str, Any] = {
            "id": f"{mountain_id}-{i:03d}",
            "type": c["type"],
            "lat": c["lat"],
            "lon": c["lon"],
            "source": "auto",
            "candidate_id": c["id"],
        }
        for key in CARRY_FIELDS:
            if c.get(key) is not None:
                point[key] = c[key]
        points.append(point)

    return {
        "mountain": {"id": mountain_id, "name": mountain_name},
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reviewed": False,
        "points": points,
    }


def run(candidates_path: str, mountain_id: str, mountain_name: str, out_path: str,
        types: Optional[Sequence[str]] = None, min_score: float = 0.0,
        skip_low_quality: bool = True, limit: Optional[int] = None,
        quiet: bool = False) -> dict[str, Any]:
    confirmed = adopt(candidates_path, mountain_id, mountain_name,
                      types, min_score, skip_low_quality, limit)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(confirmed, ensure_ascii=False, indent=1), encoding="utf-8")
    with_frame = sum(1 for p in confirmed["points"] if "frame_time_s" in p)
    if not quiet:
        print(f"{len(confirmed['points'])}地点を採用しました"
              f"（画像あり {with_frame} / 3D専用 {len(confirmed['points']) - with_frame}）")
        print(f"書き出し: {out}")
        print("※ レビューを省いています。出題の質を上げたいときは review.html で選び直してください")
    return confirmed


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="候補をまとめて採用する（レビュー省略）")
    ap.add_argument("--candidates", default="pipeline/data/candidates.json")
    ap.add_argument("--mountain-id", required=True)
    ap.add_argument("--mountain-name", required=True)
    ap.add_argument("--out", default="pipeline/data/confirmed_points.json")
    ap.add_argument("--types", help="採用する種別をカンマ区切りで（既定は全部）")
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--keep-low-quality", action="store_true",
                    help="low_quality の候補も採用する")
    ap.add_argument("--limit", type=int, help="採用する上限件数")
    args = ap.parse_args(argv)
    try:
        run(args.candidates, args.mountain_id, args.mountain_name, args.out,
            types=[t.strip() for t in args.types.split(",")] if args.types else None,
            min_score=args.min_score,
            skip_low_quality=not args.keep_low_quality,
            limit=args.limit)
    except (AdoptError, OSError, json.JSONDecodeError, KeyError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
