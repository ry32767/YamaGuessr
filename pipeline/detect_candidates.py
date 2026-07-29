#!/usr/bin/env python3
"""ルートから出題候補地点を自動検出する（機能B）。

`bend` / `peak` / `col` はルートの形と標高だけで、
`ridge_view` / `ridge_start` は国土地理院DEMの地形を見て判定する。
すべて「候補」であり、最終採否は `review.html` で人間が行う。

入力は2通り::

    # 動画と照合済みのトラック（切り出し時刻つきの候補になる）
    python pipeline/detect_candidates.py --track pipeline/data/track.json \\
        --out pipeline/data/candidates.json

    # GPXだけ（動画がまだ無い／3Dビューだけで出題する場合）
    python pipeline/detect_candidates.py --gpx Source/route.gpx \\
        --out pipeline/data/candidates.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

from dem import DemError, DemReader
from frame_quality import (DEFAULT_BLUR_RELATIVE_FACTOR, DEFAULT_BLUR_THRESHOLD,
                           DEFAULT_BRIGHTNESS_RANGE, FrameQualityError,
                           evaluate_frame)
from geo import LatLon, angle_diff_deg, bearing_deg, haversine_m
from gpx import load_gpx

# --- 既定のしきい値（実データを見ながら調整する。docs/pipeline.md に説明を置く） ---
#: ルートを何mおきのノードに均すか
DEFAULT_NODE_SPACING_M = 10.0
#: 屈曲とみなす方位変化 [deg]
DEFAULT_BEND_MIN_DEG = 30.0
#: 屈曲を測る前後の距離 [m]
BEND_ARM_M = 60.0
#: ピーク／コルとみなす最小の高低差 [m]
DEFAULT_PEAK_PROMINENCE_M = 15.0
DEFAULT_COL_PROMINENCE_M = 10.0
#: 標高を均す窓 [m]（GPS標高のノイズ対策）
ELEVATION_SMOOTH_M = 40.0
#: 遠望判定に使う方位の数と最大距離
VIEW_AZIMUTH_COUNT = 16
VIEW_MAX_DISTANCE_M = 2000.0
VIEW_STEP_M = 50.0
#: 「開けている」とみなす仰角の上限 [deg]
VIEW_OPEN_ANGLE_DEG = -2.0
#: 展望地とみなす開放率
DEFAULT_VIEW_MIN_OPENNESS = 0.3
#: 尾根らしさを測る左右の距離 [m] と、尾根とみなす盛り上がり [m]
RIDGE_ARM_M = 60.0
RIDGE_MIN_RISE_M = 4.0
#: 尾根に乗ったと認めるのに必要な継続距離 [m]
RIDGE_SUSTAIN_M = 150.0
#: 同種の候補を間引く最小間隔（経路長）[m]
DEFAULT_MIN_SEPARATION_M = 150.0
#: 種別をまたいで候補を間引く最小間隔（実距離）[m]。往復・周回の重複対策
DEFAULT_MIN_GEO_SEPARATION_M = 150.0

CANDIDATE_TYPES = ("bend", "ridge_view", "ridge_start", "peak", "col")

#: 同じ場所で種別がぶつかったときの優先度（大きいほど残す）。
#: 出題として面白いのは「そこがどこか特定しやすい地形」なので、
#: ピーク・コルを曲がり角より優先する。
TYPE_PRIORITY: dict[str, int] = {
    "peak": 4, "col": 3, "ridge_start": 2, "ridge_view": 1, "bend": 0,
}


class DetectError(RuntimeError):
    """候補検出を続行できない。"""


# ---------------------------------------------------------------------------
# ルートノード
# ---------------------------------------------------------------------------
class Node:
    """ルート上の等間隔サンプル。"""

    __slots__ = ("lat", "lon", "route_distance_m", "ele_m", "extra")

    def __init__(self, lat: float, lon: float, route_distance_m: float,
                 ele_m: Optional[float], extra: dict[str, Any]) -> None:
        self.lat = lat
        self.lon = lon
        self.route_distance_m = route_distance_m
        self.ele_m = ele_m
        self.extra = extra

    @property
    def latlon(self) -> LatLon:
        return LatLon(self.lat, self.lon)


def nodes_from_track(track_path: Path, spacing_m: float) -> list[Node]:
    """match_gpx.py の track.json から等間隔ノードを作る。

    `suspect` なサンプルは位置の根拠が無いので捨てる（docs/spec.md 機能B）。
    """
    data = json.loads(track_path.read_text(encoding="utf-8"))
    samples = [s for s in data.get("samples", []) if not s.get("suspect")]
    if len(samples) < 2:
        raise DetectError(f"{track_path} に使えるサンプルがありません（suspect除外後）")

    nodes: list[Node] = []
    last_d = -math.inf
    for s in samples:
        d = s.get("route_distance_m")
        if d is None:
            continue
        if d - last_d < spacing_m and nodes:
            continue
        last_d = d
        extra = {k: s[k] for k in ("media_id", "time_s", "real_time", "heading_deg",
                                  "heading_route_deg") if k in s}
        if "time_s" in extra:
            extra["frame_time_s"] = extra.pop("time_s")
        nodes.append(Node(s["lat"], s["lon"], d, s.get("altitude_m"), extra))
    if len(nodes) < 3:
        raise DetectError("ノードが少なすぎます。--spacing を小さくしてください")
    return nodes


def nodes_from_gpx(gpx_path: Path, spacing_m: float) -> list[Node]:
    """GPX を等間隔にリサンプリングしてノードにする（動画が無い場合）。"""
    track = load_gpx(gpx_path)
    line = track.polyline
    nodes: list[Node] = []
    d = 0.0
    while d <= line.length_m:
        p = line.point_at(d)
        nodes.append(Node(p.lat, p.lon, d, None, {}))
        d += spacing_m
    if len(nodes) < 3:
        raise DetectError("GPXが短すぎて候補を検出できません")

    # GPXの標高を経路長で内挿して持たせる（DEMを使わない場合の保険）
    along = 0.0
    gpx_along: list[float] = [0.0]
    for a, b in zip(track.points, track.points[1:]):
        along += haversine_m(LatLon(a.lat, a.lon), LatLon(b.lat, b.lon))
        gpx_along.append(along)
    eles = [p.ele for p in track.points]
    for n in nodes:
        n.ele_m = _interp(gpx_along, eles, n.route_distance_m)
    return nodes


def _interp(xs: Sequence[float], ys: Sequence[Optional[float]],
            x: float) -> Optional[float]:
    if not xs:
        return None
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    lo, hi = 0, len(xs) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if xs[mid] <= x:
            lo = mid
        else:
            hi = mid
    y0, y1 = ys[lo], ys[lo + 1]
    if y0 is None or y1 is None:
        return y0 if y0 is not None else y1
    span = xs[lo + 1] - xs[lo]
    t = 0.0 if span == 0 else (x - xs[lo]) / span
    return y0 + t * (y1 - y0)


def fill_elevation_from_dem(nodes: Sequence[Node], reader: DemReader) -> int:
    """全ノードの標高をDEMで置き換える。取れた件数を返す。

    GPS標高（気圧高度）よりDEMの方が一貫しているため、取れるならDEMを優先する。
    """
    ok = 0
    for n in nodes:
        e = reader.elevation(n.lat, n.lon)
        if e is not None:
            n.ele_m = e
            ok += 1
    return ok


def smooth_elevations(nodes: Sequence[Node], window_m: float) -> list[Optional[float]]:
    """経路長方向の移動平均で標高を均す。"""
    out: list[Optional[float] ] = []
    n = len(nodes)
    for i in range(n):
        total = 0.0
        count = 0
        for j in range(i, -1, -1):
            if nodes[i].route_distance_m - nodes[j].route_distance_m > window_m / 2:
                break
            if nodes[j].ele_m is not None:
                total += nodes[j].ele_m
                count += 1
        for j in range(i + 1, n):
            if nodes[j].route_distance_m - nodes[i].route_distance_m > window_m / 2:
                break
            if nodes[j].ele_m is not None:
                total += nodes[j].ele_m
                count += 1
        out.append(total / count if count else None)
    return out


# ---------------------------------------------------------------------------
# 検出器
# ---------------------------------------------------------------------------
def _node_at(nodes: Sequence[Node], i: int, offset_m: float) -> Optional[int]:
    """i から経路長で offset_m 離れたノードの添字。"""
    target = nodes[i].route_distance_m + offset_m
    if offset_m >= 0:
        for j in range(i, len(nodes)):
            if nodes[j].route_distance_m >= target:
                return j
        return None
    for j in range(i, -1, -1):
        if nodes[j].route_distance_m <= target:
            return j
    return None


def detect_bends(nodes: Sequence[Node], min_deg: float,
                 arm_m: float = BEND_ARM_M) -> list[dict[str, Any]]:
    """進行方位が大きく変わる点（曲がり角）。"""
    deltas: list[Optional[float]] = [None] * len(nodes)
    for i in range(len(nodes)):
        a = _node_at(nodes, i, -arm_m)
        b = _node_at(nodes, i, arm_m)
        if a is None or b is None or a == i or b == i:
            continue
        b_in = bearing_deg(nodes[a].latlon, nodes[i].latlon)
        b_out = bearing_deg(nodes[i].latlon, nodes[b].latlon)
        deltas[i] = abs(angle_diff_deg(b_out, b_in))

    out: list[dict[str, Any]] = []
    for i, d in enumerate(deltas):
        if d is None or d < min_deg:
            continue
        # 前後 arm_m の中で最大のものだけ残す
        lo = _node_at(nodes, i, -arm_m) or 0
        hi = _node_at(nodes, i, arm_m) or len(nodes) - 1
        if any(deltas[j] is not None and deltas[j] > d for j in range(lo, hi + 1)):
            continue
        out.append({
            "index": i,
            "type": "bend",
            "score": min(1.0, d / 120.0),
            "detail": {"bearing_change_deg": round(d, 1)},
        })
    return out


def _prominence(eles: Sequence[Optional[float]], i: int, sign: int) -> Optional[float]:
    """i を頂点（sign=+1）／底（sign=-1）としたときの、左右で小さい方の高低差。"""
    base = eles[i]
    if base is None:
        return None
    best: list[float] = []
    for step in (-1, 1):
        extreme = base
        found = 0.0
        j = i + step
        while 0 <= j < len(eles):
            e = eles[j]
            if e is None:
                j += step
                continue
            if sign * (e - base) > 0:  # 反対側の峰／谷に達した
                break
            if sign * (e - extreme) < 0:
                extreme = e
            found = abs(base - extreme)
            j += step
        best.append(found)
    return min(best) if best else None


def detect_peaks_and_cols(nodes: Sequence[Node], eles: Sequence[Optional[float]],
                          peak_prominence_m: float,
                          col_prominence_m: float) -> list[dict[str, Any]]:
    """ルート沿いの標高の極大（ピーク）・極小（コル）。"""
    out: list[dict[str, Any]] = []
    for i in range(1, len(nodes) - 1):
        e = eles[i]
        prev_e, next_e = eles[i - 1], eles[i + 1]
        if e is None or prev_e is None or next_e is None:
            continue
        if e >= prev_e and e >= next_e and (e > prev_e or e > next_e):
            p = _prominence(eles, i, 1)
            if p is not None and p >= peak_prominence_m:
                out.append({"index": i, "type": "peak",
                            "score": min(1.0, p / 100.0),
                            "detail": {"prominence_m": round(p, 1),
                                       "elevation_m": round(e, 1)}})
        if e <= prev_e and e <= next_e and (e < prev_e or e < next_e):
            p = _prominence(eles, i, -1)
            if p is not None and p >= col_prominence_m:
                out.append({"index": i, "type": "col",
                            "score": min(1.0, p / 80.0),
                            "detail": {"prominence_m": round(p, 1),
                                       "elevation_m": round(e, 1)}})
    return out


def openness_at(reader: DemReader, node: Node, ele: float) -> dict[str, Any]:
    """その地点の開放度（何方位で遠望が利くか）を測る。"""
    open_count = 0
    angles: list[float] = []
    open_bearings: list[float] = []
    for k in range(VIEW_AZIMUTH_COUNT):
        az = 360.0 * k / VIEW_AZIMUTH_COUNT
        angle, _dist = reader.max_view_angle_deg(
            node.latlon, ele, az, VIEW_MAX_DISTANCE_M, VIEW_STEP_M)
        angles.append(angle)
        if angle < VIEW_OPEN_ANGLE_DEG:
            open_count += 1
            open_bearings.append(az)
    return {
        "openness": open_count / VIEW_AZIMUTH_COUNT,
        "min_view_angle_deg": round(min(angles), 2),
        "open_bearings": open_bearings,
    }


def detect_ridge_views(nodes: Sequence[Node], eles: Sequence[Optional[float]],
                       reader: DemReader, min_openness: float,
                       sample_spacing_m: float = 50.0) -> list[dict[str, Any]]:
    """遠望が利く地点（尾根上・展望地）。DEMで全方位の視線を見る。"""
    out: list[dict[str, Any]] = []
    scores: dict[int, float] = {}
    last_d = -math.inf
    for i, node in enumerate(nodes):
        if node.route_distance_m - last_d < sample_spacing_m:
            continue
        last_d = node.route_distance_m
        e = eles[i]
        if e is None:
            continue
        info = openness_at(reader, node, e)
        scores[i] = info["openness"]
        if info["openness"] < min_openness:
            continue
        out.append({
            "index": i,
            "type": "ridge_view",
            "score": min(1.0, info["openness"]),
            "detail": {"openness": round(info["openness"], 3),
                       "min_view_angle_deg": info["min_view_angle_deg"],
                       "open_bearings": info["open_bearings"]},
        })
    return out


def ridgeness_at(reader: DemReader, node: Node, ele: float,
                 travel_bearing: float, arm_m: float = RIDGE_ARM_M) -> Optional[float]:
    """進行方向に直交する断面での盛り上がり [m]。正なら尾根上。"""
    left = reader.elevation(*_offset(node, travel_bearing - 90.0, arm_m))
    right = reader.elevation(*_offset(node, travel_bearing + 90.0, arm_m))
    if left is None or right is None:
        return None
    return ele - (left + right) / 2.0


def _offset(node: Node, bearing: float, dist_m: float) -> tuple[float, float]:
    rad = math.radians(bearing)
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(node.lat))
    return (node.lat + dist_m * math.cos(rad) / m_per_deg_lat,
            node.lon + dist_m * math.sin(rad) / m_per_deg_lon)


def detect_ridge_starts(nodes: Sequence[Node], eles: Sequence[Optional[float]],
                        reader: DemReader,
                        sustain_m: float = RIDGE_SUSTAIN_M) -> list[dict[str, Any]]:
    """尾根に乗り始めた地点。尾根らしさが立ち上がり、その後継続する点を拾う。

    自動検出の精度は低い見込みで、半自動レビューでの人間判断に強く依存する
    （docs/spec.md 未決定事項）。
    """
    ridgeness: list[Optional[float]] = [None] * len(nodes)
    for i, node in enumerate(nodes):
        e = eles[i]
        if e is None:
            continue
        nxt = _node_at(nodes, i, 30.0)
        if nxt is None or nxt == i:
            continue
        travel = bearing_deg(node.latlon, nodes[nxt].latlon)
        ridgeness[i] = ridgeness_at(reader, node, e, travel)

    out: list[dict[str, Any]] = []
    on_ridge = [r is not None and r >= RIDGE_MIN_RISE_M for r in ridgeness]
    i = 1
    while i < len(nodes):
        if not (on_ridge[i] and not on_ridge[i - 1]):
            i += 1
            continue
        # ここから sustain_m 以上、尾根が続くか
        end = _node_at(nodes, i, sustain_m)
        if end is None:
            break
        span = range(i, end + 1)
        ratio = sum(1 for j in span if on_ridge[j]) / max(1, len(list(span)))
        if ratio >= 0.7:
            values = [ridgeness[j] for j in span if ridgeness[j] is not None]
            out.append({
                "index": i,
                "type": "ridge_start",
                "score": min(1.0, (sum(values) / len(values)) / 20.0) if values else 0.3,
                "detail": {"ridgeness_m": round(ridgeness[i] or 0.0, 1),
                           "sustain_ratio": round(ratio, 2)},
            })
            i = end + 1
        else:
            i += 1
    return out


# ---------------------------------------------------------------------------
# 間引き・組み立て
# ---------------------------------------------------------------------------
def thin_candidates(cands: Sequence[dict[str, Any]], nodes: Sequence[Node],
                    min_separation_m: float,
                    min_geo_separation_m: float) -> list[dict[str, Any]]:
    """近すぎる候補をスコアの高い方だけ残して間引く。

    2段階で行う。

    1. **経路長での間引き**（同じ種別のみ）：連続する似た検出をまとめる
    2. **地理的な間引き**（種別をまたぐ）：往復・周回で同じ場所を2度通ると
       同一地点が重複して候補になるため、実距離で近いものを潰す。
       出題としては「同じ景色が2回出る」のが一番まずい
    """
    kept: list[dict[str, Any]] = []
    for c in sorted(cands, key=lambda c: -c["score"]):
        d = nodes[c["index"]].route_distance_m
        too_close = any(
            k["type"] == c["type"]
            and abs(nodes[k["index"]].route_distance_m - d) < min_separation_m
            for k in kept)
        if not too_close:
            kept.append(c)

    geo_kept: list[dict[str, Any]] = []
    for c in sorted(kept, key=lambda c: (-TYPE_PRIORITY.get(c["type"], 0), -c["score"])):
        here = nodes[c["index"]].latlon
        if any(haversine_m(here, nodes[k["index"]].latlon) < min_geo_separation_m
               for k in geo_kept):
            continue
        geo_kept.append(c)

    geo_kept.sort(key=lambda c: nodes[c["index"]].route_distance_m)
    return geo_kept


def build_candidates(nodes: Sequence[Node], raw: Sequence[dict[str, Any]],
                     eles: Sequence[Optional[float]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for seq, c in enumerate(raw, start=1):
        node = nodes[c["index"]]
        rec: dict[str, Any] = {
            "id": f"cand-{seq:04d}",
            "type": c["type"],
            "lat": round(node.lat, 7),
            "lon": round(node.lon, 7),
            "route_distance_m": round(node.route_distance_m, 1),
            "score": round(c["score"], 3),
            "detail": c["detail"],
        }
        e = eles[c["index"]]
        if e is not None:
            rec["elevation_m"] = round(e, 1)
        for key in ("media_id", "frame_time_s", "real_time",
                    "heading_deg", "heading_route_deg"):
            if key in node.extra:
                rec[key] = node.extra[key]
        rec["has_frame"] = "frame_time_s" in rec
        out.append(rec)
    return out


def apply_frame_quality(candidates: Sequence[dict[str, Any]],
                        videos: dict[str, str],
                        blur_threshold: float = DEFAULT_BLUR_THRESHOLD,
                        relative_factor: float = DEFAULT_BLUR_RELATIVE_FACTOR,
                        brightness_range: tuple[float, float] = DEFAULT_BRIGHTNESS_RANGE
                        ) -> dict[str, Any]:
    """候補の切り出しフレームの品質を測り、`low_quality` を付ける。

    地面向き・ブレ・逆光のフレームをレビュー時に見分けられるようにするため。
    測れなかった候補は素通しする（採否は人間が決める）。

    ブレの絶対値はカメラ・画角・被写体で桁が変わる（実測：Osmo Action 6 の
    4K実写で 1500〜2500）。そのため**その動画自身の中央値に対する相対値**と、
    最低ラインとしての絶対しきい値の、大きい方で判定する。
    """
    measured: list[tuple[dict[str, Any], Any]] = []
    stats: dict[str, Any] = {"evaluated": 0, "low_quality": 0, "failed": 0}
    for c in candidates:
        if "frame_time_s" not in c:
            continue
        video = videos.get(c.get("media_id", "")) or videos.get("*")
        if not video:
            continue
        try:
            q = evaluate_frame(video, c["frame_time_s"], blur_threshold, brightness_range)
        except FrameQualityError:
            stats["failed"] += 1
            continue
        c["blur_score"] = q.blur_score
        c["brightness"] = q.brightness
        measured.append((c, q))

    if not measured:
        return stats

    blurs = sorted(q.blur_score for _c, q in measured)
    median = blurs[len(blurs) // 2]
    effective = max(blur_threshold, median * relative_factor)

    for c, q in measured:
        reasons = [r for r in q.reasons if r != "blur"]
        if q.blur_score < effective:
            reasons.insert(0, "blur")
        c["low_quality"] = bool(reasons)
        if reasons:
            c["low_quality_reasons"] = reasons
        elif "low_quality_reasons" in c:
            del c["low_quality_reasons"]

    stats["evaluated"] = len(measured)
    stats["low_quality"] = sum(1 for c, _q in measured if c["low_quality"])
    stats["blur_median"] = round(median, 2)
    stats["blur_threshold_used"] = round(effective, 2)
    return stats


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


# ---------------------------------------------------------------------------
# 実行
# ---------------------------------------------------------------------------
def run(track: Optional[str] = None, gpx: Optional[str] = None,
        out_path: str = "pipeline/data/candidates.json",
        spacing_m: float = DEFAULT_NODE_SPACING_M,
        bend_min_deg: float = DEFAULT_BEND_MIN_DEG,
        peak_prominence_m: float = DEFAULT_PEAK_PROMINENCE_M,
        col_prominence_m: float = DEFAULT_COL_PROMINENCE_M,
        view_min_openness: float = DEFAULT_VIEW_MIN_OPENNESS,
        min_separation_m: float = DEFAULT_MIN_SEPARATION_M,
        min_geo_separation_m: float = DEFAULT_MIN_GEO_SEPARATION_M,
        use_dem: bool = True, dem_source: str = "dem",
        dem_offline: bool = False, dem_cache_dir: Optional[str | Path] = None,
        videos: Optional[dict[str, str]] = None,
        blur_threshold: float = DEFAULT_BLUR_THRESHOLD,
        blur_relative_factor: float = DEFAULT_BLUR_RELATIVE_FACTOR,
        types: Sequence[str] = CANDIDATE_TYPES,
        quiet: bool = False) -> dict[str, Any]:
    """候補を検出して candidates.json を書き出す。戻り値は meta。"""
    if bool(track) == bool(gpx):
        raise DetectError("--track か --gpx のどちらか一方を指定してください")

    if track:
        nodes = nodes_from_track(Path(track), spacing_m)
        source = {"kind": "track", "path": track}
    else:
        nodes = nodes_from_gpx(Path(gpx), spacing_m)  # type: ignore[arg-type]
        source = {"kind": "gpx", "path": gpx}

    reader: Optional[DemReader] = None
    dem_info: dict[str, Any] = {"used": False}
    if use_dem:
        kwargs: dict[str, Any] = {"source": dem_source, "offline": dem_offline}
        if dem_cache_dir is not None:
            kwargs["cache_dir"] = dem_cache_dir
        reader = DemReader(**kwargs)
        lats = [n.lat for n in nodes]
        lons = [n.lon for n in nodes]
        tiles = reader.prefetch_bbox(min(lats), min(lons), max(lats), max(lons),
                                     margin_m=VIEW_MAX_DISTANCE_M)
        filled = fill_elevation_from_dem(nodes, reader)
        dem_info = {"used": True, "source": dem_source, "zoom": reader.zoom,
                    "tiles": tiles, "fetched": reader.fetch_count,
                    "cached": reader.cache_hit_count,
                    "elevation_filled": filled, "node_count": len(nodes)}

    eles = smooth_elevations(nodes, ELEVATION_SMOOTH_M)

    raw: list[dict[str, Any]] = []
    if "bend" in types:
        raw += detect_bends(nodes, bend_min_deg)
    if "peak" in types or "col" in types:
        for c in detect_peaks_and_cols(nodes, eles, peak_prominence_m, col_prominence_m):
            if c["type"] in types:
                raw.append(c)
    if reader is not None and "ridge_view" in types:
        raw += detect_ridge_views(nodes, eles, reader, view_min_openness)
    if reader is not None and "ridge_start" in types:
        raw += detect_ridge_starts(nodes, eles, reader)

    thinned = thin_candidates(raw, nodes, min_separation_m, min_geo_separation_m)
    candidates = build_candidates(nodes, thinned, eles)

    quality_stats: dict[str, Any] = {}
    if videos:
        quality_stats = apply_frame_quality(candidates, videos, blur_threshold,
                                            blur_relative_factor)

    by_type = {t: sum(1 for c in candidates if c["type"] == t) for t in CANDIDATE_TYPES}
    meta: dict[str, Any] = {
        "source": source,
        "node_count": len(nodes),
        "node_spacing_m": spacing_m,
        "route_length_m": round(nodes[-1].route_distance_m, 1),
        "dem": dem_info,
        "thresholds": {
            "bend_min_deg": bend_min_deg,
            "peak_prominence_m": peak_prominence_m,
            "col_prominence_m": col_prominence_m,
            "view_min_openness": view_min_openness,
            "min_separation_m": min_separation_m,
            "min_geo_separation_m": min_geo_separation_m,
        },
        "raw_candidate_count": len(raw),
        "candidate_count": len(candidates),
        "by_type": by_type,
        "with_frame": sum(1 for c in candidates if c["has_frame"]),
        "frame_quality": quality_stats,
    }

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"meta": meta, "candidates": candidates},
                              ensure_ascii=False, indent=1), encoding="utf-8")

    if not quiet:
        print(f"ノード: {len(nodes)}件（{spacing_m}m間隔 / 全長 {meta['route_length_m']}m）")
        if dem_info["used"]:
            print(f"DEM: {dem_source} z={reader.zoom if reader else '-'} "  # type: ignore[union-attr]
                  f"タイル{dem_info['tiles']}枚"
                  f"（新規取得{dem_info['fetched']} / キャッシュ{dem_info['cached']}）")
        print(f"候補: {len(candidates)}件  " +
              " ".join(f"{t}={by_type[t]}" for t in CANDIDATE_TYPES))
        if quality_stats:
            print(f"フレーム品質: {quality_stats['evaluated']}件を評価 "
                  f"（low_quality {quality_stats['low_quality']}件 / "
                  f"取得失敗 {quality_stats['failed']}件）")
        print(f"書き出し: {out}")
        if meta["with_frame"] == 0:
            print("注意: 切り出し時刻を持つ候補がありません"
                  "（動画未照合）。3Dビューのみでの出題になります", file=sys.stderr)
    return meta


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="出題候補地点の自動検出")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--track", help="match_gpx.py が出した track.json")
    src.add_argument("--gpx", help="GPX だけで検出する場合のルート")
    ap.add_argument("--out", default="pipeline/data/candidates.json")
    ap.add_argument("--spacing", type=float, default=DEFAULT_NODE_SPACING_M)
    ap.add_argument("--bend-min-deg", type=float, default=DEFAULT_BEND_MIN_DEG)
    ap.add_argument("--peak-prominence-m", type=float, default=DEFAULT_PEAK_PROMINENCE_M)
    ap.add_argument("--col-prominence-m", type=float, default=DEFAULT_COL_PROMINENCE_M)
    ap.add_argument("--view-min-openness", type=float, default=DEFAULT_VIEW_MIN_OPENNESS)
    ap.add_argument("--min-separation-m", type=float, default=DEFAULT_MIN_SEPARATION_M,
                    help="同種の候補を間引く最小間隔（経路長）")
    ap.add_argument("--min-geo-separation-m", type=float,
                    default=DEFAULT_MIN_GEO_SEPARATION_M,
                    help="種別をまたいで間引く最小間隔（実距離）。往復・周回の重複対策")
    ap.add_argument("--video", action="append",
                    help="フレーム品質を測る動画。'path' か 'media_id=path'（複数可）")
    ap.add_argument("--blur-threshold", type=float, default=DEFAULT_BLUR_THRESHOLD,
                    help="ブレ判定の絶対的な最低ライン（ラプラシアン分散）")
    ap.add_argument("--blur-relative-factor", type=float,
                    default=DEFAULT_BLUR_RELATIVE_FACTOR,
                    help="その動画のブレ値の中央値に対する相対しきい値")
    ap.add_argument("--no-dem", action="store_true", help="DEMを使わない（尾根系は検出不可）")
    ap.add_argument("--dem-source", default="dem", choices=["dem", "dem5a"])
    ap.add_argument("--dem-offline", action="store_true",
                    help="キャッシュ済みタイルだけを使う（通信しない）")
    ap.add_argument("--types", default=",".join(CANDIDATE_TYPES),
                    help="検出する種別をカンマ区切りで")
    args = ap.parse_args(argv)

    try:
        run(track=args.track, gpx=args.gpx, out_path=args.out, spacing_m=args.spacing,
            bend_min_deg=args.bend_min_deg,
            peak_prominence_m=args.peak_prominence_m,
            col_prominence_m=args.col_prominence_m,
            view_min_openness=args.view_min_openness,
            min_separation_m=args.min_separation_m,
            min_geo_separation_m=args.min_geo_separation_m,
            use_dem=not args.no_dem, dem_source=args.dem_source,
            dem_offline=args.dem_offline,
            videos=parse_video_args(args.video),
            blur_threshold=args.blur_threshold,
            blur_relative_factor=args.blur_relative_factor,
            types=tuple(t.strip() for t in args.types.split(",") if t.strip()))
    except (DetectError, DemError, ValueError, OSError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
