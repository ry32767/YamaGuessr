#!/usr/bin/env python3
"""テレメトリを GPX ルートに突き合わせ、出題に使える track.json を作る（機能A-2）。

**このステップが出題の正確さを決める。** 正解座標は必ず GPX 由来にする
（生GPSは誤差が大きく、実測では全フレーム固定される事例もあった）。

照合方式は2つあり、既定（``--mode auto``）では自動で選ぶ。

``snap``
    テレメトリの生GPSを GPX ルート上の最近傍点に落とす。GPSが更新されている動画向け。
``time``
    ファイル名由来の撮影開始時刻＋``capture_us`` の経過から実時刻を求め、
    GPX のトラックポイントを時刻で内挿する。**GPXの時刻が「実際に歩いた記録」だと
    確認できているときだけ使うこと。** 計画のGPXでは時刻が実際とずれるので、
    位置がまったく合わない。そのため ``auto`` では選ばれない。

複数の動画（DJIの自動分割）をまとめて渡せる。各サンプルには ``media_id`` が付く。

使い方::

    python pipeline/match_gpx.py --gpx Source/route.gpx \\
        --telemetry pipeline/data/telemetry.json \\
        --out pipeline/data/track.json
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

from geo import (AXES, WORLD_CONVENTIONS, LatLon, angle_diff_deg, bearing_deg,
                 haversine_m, quat_to_heading_deg)
from gpx import GpxTrack, load_gpx

#: これを超えて GPX から離れたサンプルは正解として使えない
DEFAULT_SNAP_THRESHOLD_M = 50.0
#: 時刻照合で、最寄りのトラックポイントとの時間差がこれを超えたら疑わしい
DEFAULT_TIME_GAP_THRESHOLD_S = 60.0
#: heading 検証に使う「直進とみなす」条件
STRAIGHT_MIN_SPEED_MPS = 0.3
STRAIGHT_MAX_BEARING_CHANGE_DEG = 10.0


class MatchError(RuntimeError):
    """照合を続行できない致命的エラー。"""


# ---------------------------------------------------------------------------
# 入力の読み込み
# ---------------------------------------------------------------------------
def _parse_tz(text: str) -> timezone:
    """"+09:00" 形式のタイムゾーン指定を timezone にする。"""
    try:
        dt = datetime.fromisoformat(f"2000-01-01T00:00:00{text}")
    except ValueError as e:
        raise MatchError(f"タイムゾーンの指定が不正です: {text}") from e
    if dt.tzinfo is None:
        raise MatchError(f"タイムゾーンの指定が不正です: {text}")
    return timezone(dt.utcoffset() or timedelta(0))


def _find_start_local(telemetry_path: Path) -> Optional[str]:
    """テレメトリJSONの隣にあるサマリ、無ければファイル名から開始時刻を拾う。"""
    stem = telemetry_path.stem
    for cand in (telemetry_path.with_name(f"{stem}_summary.json"),
                 telemetry_path.with_name("telemetry_summary.json")):
        if cand.exists():
            try:
                summary = json.loads(cand.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            start = (summary.get("source") or {}).get("start_local")
            if start:
                return str(start)
    # サマリが無ければテレメトリのファイル名自体を見る
    import extract_telemetry as et
    return et.start_time_from_filename(telemetry_path)


def load_media(telemetry_path: Path, tz: timezone,
               start_override: Optional[str], time_offset_s: float) -> dict[str, Any]:
    """テレメトリJSONを読み、各サンプルに実時刻を付けて返す。"""
    rows: list[dict[str, Any]] = json.loads(telemetry_path.read_text(encoding="utf-8"))
    if not rows:
        raise MatchError(f"{telemetry_path} にサンプルがありません")

    start_local = start_override or _find_start_local(telemetry_path)
    if not start_local:
        raise MatchError(
            f"{telemetry_path} の撮影開始時刻が分かりません。"
            "--start で ISO8601（例 2026-07-11T12:53:58）を指定してください"
        )
    start_dt = datetime.fromisoformat(start_local)
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=tz)
    start_dt = start_dt.astimezone(timezone.utc) + timedelta(seconds=time_offset_s)

    base_us = rows[0].get("capture_us")
    samples: list[dict[str, Any]] = []
    for r in rows:
        if base_us is not None and r.get("capture_us") is not None:
            elapsed = (r["capture_us"] - base_us) / 1e6
        else:
            # capture_us が無い動画では動画時間で代用する（タイムラプスでは不正確）
            elapsed = float(r.get("time_s", 0.0))
        s = dict(r)
        s["elapsed_s"] = round(elapsed, 4)
        s["real_time"] = (start_dt + timedelta(seconds=elapsed)).isoformat()
        samples.append(s)

    distinct_gps = {(r["lat"], r["lon"]) for r in rows if "lat" in r and "lon" in r}
    return {
        "media_id": telemetry_path.stem,
        "telemetry_path": str(telemetry_path),
        "start_utc": start_dt.isoformat(),
        "sample_count": len(samples),
        "distinct_gps_fix_count": len(distinct_gps),
        "samples": samples,
    }


# ---------------------------------------------------------------------------
# 照合
# ---------------------------------------------------------------------------
def choose_mode(media: Sequence[dict[str, Any]], track: GpxTrack, mode: str) -> str:
    """``auto`` のとき、GPSの状態から照合方式を決める。

    **時刻照合は auto では選ばない。** GPXの時刻は「計画」であることがあり
    （ヤマレコ／YAMAPの計画をそのまま書き出した場合など）、実際に歩いた時刻とは
    無関係になりうる。時刻を信じてよいと分かっているときだけ `--mode time` を
    明示すること（docs/spec.md の設計判断表）。
    """
    if mode != "auto":
        return mode
    live_gps = any(m["distinct_gps_fix_count"] >= 2 for m in media)
    if live_gps:
        return "snap"
    raise MatchError(
        "テレメトリGPSが動いていないため、座標スナップができません。\n"
        "GPXの時刻が『実際に歩いた記録』だと確認できているなら --mode time を指定してください。\n"
        "計画のGPXなら時刻は当てにならないので、動画は画像の供給源として扱い、"
        "地点は detect_candidates.py（GPXの形だけ）で作ってください。"
    )


def match_samples(media: Sequence[dict[str, Any]], track: GpxTrack, mode: str,
                  snap_threshold_m: float,
                  time_gap_threshold_s: float) -> list[dict[str, Any]]:
    """全メディアのサンプルをGPXに突き合わせ、実時刻順に並べて返す。"""
    out: list[dict[str, Any]] = []
    for m in media:
        hint: Optional[int] = None
        for s in m["samples"]:
            rec: dict[str, Any] = {
                "media_id": m["media_id"],
                "frame_index": s.get("frame_index"),
                "time_s": s.get("time_s"),
                "capture_us": s.get("capture_us"),
                "elapsed_s": s.get("elapsed_s"),
                "real_time": s["real_time"],
                "match_method": mode,
            }
            if "lat" in s and "lon" in s:
                rec["raw_lat"] = s["lat"]
                rec["raw_lon"] = s["lon"]
            for key in ("altitude_m", "gps_acc_h_m", "quat_w", "quat_x", "quat_y", "quat_z"):
                if key in s:
                    rec[key] = s[key]

            if mode == "snap":
                if "lat" not in s or "lon" not in s:
                    rec["suspect"] = True
                    rec["suspect_reason"] = "no_gps"
                    out.append(rec)
                    continue
                snapped = track.polyline.snap(s["lat"], s["lon"], hint_index=hint)
                hint = snapped.segment_index
                rec["lat"] = snapped.lat
                rec["lon"] = snapped.lon
                rec["snap_distance_m"] = round(snapped.distance_m, 2)
                rec["route_distance_m"] = round(snapped.along_m, 2)
                rec["suspect"] = snapped.distance_m > snap_threshold_m
                if rec["suspect"]:
                    rec["suspect_reason"] = "snap_distance"
            else:
                when = datetime.fromisoformat(s["real_time"])
                pos, gap_s = track.position_at(when)
                rec["lat"] = pos.lat
                rec["lon"] = pos.lon
                rec["time_gap_s"] = round(gap_s, 2)
                snapped = track.polyline.snap(pos.lat, pos.lon, hint_index=hint)
                hint = snapped.segment_index
                rec["route_distance_m"] = round(snapped.along_m, 2)
                if "raw_lat" in rec:
                    rec["snap_distance_m"] = round(
                        haversine_m(LatLon(rec["raw_lat"], rec["raw_lon"]), pos), 2)
                rec["suspect"] = gap_s > time_gap_threshold_s
                if rec["suspect"]:
                    rec["suspect_reason"] = "time_gap"
            out.append(rec)

    out.sort(key=lambda r: (r["real_time"], r["media_id"], r.get("frame_index") or 0))
    return out


# ---------------------------------------------------------------------------
# heading（カメラ方位）
# ---------------------------------------------------------------------------
def route_bearings(samples: Sequence[dict[str, Any]],
                   window: int = 15) -> list[Optional[float]]:
    """各サンプルの進行方位を、前後 ``window`` サンプルの位置差から求める。"""
    n = len(samples)
    out: list[Optional[float]] = [None] * n
    for i in range(n):
        a = samples[max(0, i - window)]
        b = samples[min(n - 1, i + window)]
        if "lat" not in a or "lat" not in b:
            continue
        pa, pb = LatLon(a["lat"], a["lon"]), LatLon(b["lat"], b["lon"])
        if haversine_m(pa, pb) < 1.0:  # ほぼ停止：方位は決まらない
            continue
        out[i] = bearing_deg(pa, pb)
    return out


def straight_indices(samples: Sequence[dict[str, Any]],
                     bearings: Sequence[Optional[float]]) -> list[int]:
    """「直進していて方位が安定している」サンプルの添字を返す。"""
    idx: list[int] = []
    for i in range(1, len(samples) - 1):
        b0, b1, b2 = bearings[i - 1], bearings[i], bearings[i + 1]
        if b0 is None or b1 is None or b2 is None:
            continue
        if (abs(angle_diff_deg(b1, b0)) > STRAIGHT_MAX_BEARING_CHANGE_DEG
                or abs(angle_diff_deg(b2, b1)) > STRAIGHT_MAX_BEARING_CHANGE_DEG):
            continue
        t0 = samples[i - 1].get("elapsed_s")
        t1 = samples[i + 1].get("elapsed_s")
        if t0 is None or t1 is None or t1 <= t0:
            continue
        dist = haversine_m(LatLon(samples[i - 1]["lat"], samples[i - 1]["lon"]),
                           LatLon(samples[i + 1]["lat"], samples[i + 1]["lon"]))
        if dist / (t1 - t0) < STRAIGHT_MIN_SPEED_MPS:
            continue
        idx.append(i)
    return idx


def _quat_of(s: dict[str, Any]) -> Optional[tuple[float, float, float, float]]:
    keys = ("quat_w", "quat_x", "quat_y", "quat_z")
    if not all(k in s for k in keys):
        return None
    return (s["quat_w"], s["quat_x"], s["quat_y"], s["quat_z"])


def evaluate_heading_conventions(samples: Sequence[dict[str, Any]],
                                 bearings: Sequence[Optional[float]],
                                 tolerance_deg: float = 20.0) -> list[dict[str, Any]]:
    """前方軸×世界座標系の全組み合わせを直進区間で評価し、一致率順に返す。

    DJIのクォータニオン規約は非公開なので、実データから当てにいく
    （docs/spec.md 機能A-2 の受け入れ条件）。
    """
    idx = straight_indices(samples, bearings)
    results: list[dict[str, Any]] = []
    if not idx:
        return results
    for forward in AXES:
        for world in WORLD_CONVENTIONS:
            hit = total = 0
            for i in idx:
                q = _quat_of(samples[i])
                b = bearings[i]
                if q is None or b is None:
                    continue
                h = quat_to_heading_deg(q, forward=forward, world=world)
                total += 1
                if abs(angle_diff_deg(h, b)) <= tolerance_deg:
                    hit += 1
            if total:
                results.append({
                    "forward": forward, "world": world,
                    "agreement": round(hit / total, 4),
                    "samples": total,
                })
    results.sort(key=lambda r: -r["agreement"])
    return results


def apply_heading(samples: Sequence[dict[str, Any]],
                  bearings: Sequence[Optional[float]],
                  forward: Optional[str], world: Optional[str]) -> None:
    """各サンプルに heading_deg（カメラ方位）と heading_route_deg（進行方位）を付ける。"""
    for i, s in enumerate(samples):
        if bearings[i] is not None:
            s["heading_route_deg"] = round(bearings[i], 2)  # type: ignore[arg-type]
        if forward and world:
            q = _quat_of(s)
            if q is not None:
                s["heading_deg"] = round(quat_to_heading_deg(q, forward, world), 2)


# ---------------------------------------------------------------------------
# 実行
# ---------------------------------------------------------------------------
def run(gpx_path: str, telemetry_paths: Sequence[str], out_path: str,
        mode: str = "auto", tz: str = "+09:00",
        starts: Optional[Sequence[str]] = None, time_offset_s: float = 0.0,
        snap_threshold_m: float = DEFAULT_SNAP_THRESHOLD_M,
        time_gap_threshold_s: float = DEFAULT_TIME_GAP_THRESHOLD_S,
        heading_tolerance_deg: float = 20.0,
        heading_min_agreement: float = 0.8,
        quiet: bool = False) -> dict[str, Any]:
    """照合を実行し track.json を書き出す。戻り値は meta 部分。"""
    track = load_gpx(gpx_path)
    tzinfo = _parse_tz(tz)

    media = []
    for i, p in enumerate(telemetry_paths):
        override = starts[i] if starts and i < len(starts) else None
        media.append(load_media(Path(p), tzinfo, override, time_offset_s))

    resolved_mode = choose_mode(media, track, mode)
    samples = match_samples(media, track, resolved_mode,
                            snap_threshold_m, time_gap_threshold_s)

    bearings = route_bearings(samples)
    conventions = evaluate_heading_conventions(samples, bearings, heading_tolerance_deg)
    best = conventions[0] if conventions else None
    use_forward = use_world = None
    if best and best["agreement"] >= heading_min_agreement:
        use_forward, use_world = best["forward"], best["world"]
    apply_heading(samples, bearings, use_forward, use_world)

    suspect_count = sum(1 for s in samples if s.get("suspect"))
    meta: dict[str, Any] = {
        "gpx": {
            "path": str(gpx_path),
            "point_count": len(track.points),
            "has_time": track.has_time,
            "length_m": round(track.polyline.length_m, 1),
            "bbox_diagonal_m": round(track.polyline.bbox_diagonal_m(), 1),
        },
        "media": [{k: v for k, v in m.items() if k != "samples"} for m in media],
        "mode_requested": mode,
        "mode_used": resolved_mode,
        "time_offset_s": time_offset_s,
        "snap_threshold_m": snap_threshold_m,
        "sample_count": len(samples),
        "suspect_count": suspect_count,
        "heading": {
            "tolerance_deg": heading_tolerance_deg,
            "min_agreement": heading_min_agreement,
            "straight_sample_count": best["samples"] if best else 0,
            "candidates": conventions[:5],
            "chosen": ({"forward": use_forward, "world": use_world}
                       if use_forward else None),
        },
    }
    if track.has_time:
        lo, hi = track.time_range
        meta["gpx"]["time_range"] = [lo.isoformat(), hi.isoformat()]

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"meta": meta, "samples": samples},
                              ensure_ascii=False, indent=1), encoding="utf-8")

    if not quiet:
        print(f"GPX: {len(track.points)}点 / 全長 {meta['gpx']['length_m']}m "
              f"/ 時刻{'あり' if track.has_time else 'なし'}")
        print(f"照合方式: {resolved_mode}（要求: {mode}）")
        if resolved_mode == "time":
            print("注意: GPXの時刻を信じた照合です。計画のGPXでは位置がまったく合いません",
                  file=sys.stderr)
        print(f"サンプル: {len(samples)}件  書き出し: {out}")
        if suspect_count:
            reason = "GPX から離れすぎ" if resolved_mode == "snap" else "GPX の時刻範囲外"
            print(f"警告: suspect {suspect_count}件 / {len(samples)}件"
                  f"（{reason}）。この区間は出題候補から除外されます", file=sys.stderr)
        if best:
            print(f"heading 最良候補: forward={best['forward']} world={best['world']} "
                  f"一致率 {best['agreement']:.1%}（直進 {best['samples']}サンプル）")
            if use_forward is None:
                print(f"警告: heading の一致率が {heading_min_agreement:.0%} に届かないため "
                      "heading_deg を出力しません。モード②の初期方位は "
                      "heading_route_deg（進行方位）で代用してください", file=sys.stderr)
        else:
            print("警告: 直進区間が見つからず heading を検証できませんでした。"
                  "heading_deg は出力していません", file=sys.stderr)
    return meta


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="テレメトリをGPXルートに突き合わせる")
    ap.add_argument("--gpx", required=True, help="登山ルートの GPX")
    ap.add_argument("--telemetry", required=True, action="append",
                    help="extract_telemetry.py が出した JSON（分割動画は複数回指定）")
    ap.add_argument("--out", default="pipeline/data/track.json")
    ap.add_argument("--mode", choices=["auto", "snap", "time"], default="auto")
    ap.add_argument("--tz", default="+09:00", help="撮影開始時刻のタイムゾーン")
    ap.add_argument("--start", action="append",
                    help="撮影開始時刻の上書き（--telemetry と同じ順で指定）")
    ap.add_argument("--time-offset-s", type=float, default=0.0,
                    help="カメラ時計とGPXの時計のずれ補正 [秒]")
    ap.add_argument("--snap-threshold-m", type=float, default=DEFAULT_SNAP_THRESHOLD_M)
    ap.add_argument("--time-gap-threshold-s", type=float,
                    default=DEFAULT_TIME_GAP_THRESHOLD_S)
    args = ap.parse_args(argv)
    try:
        run(args.gpx, args.telemetry, args.out, mode=args.mode, tz=args.tz,
            starts=args.start, time_offset_s=args.time_offset_s,
            snap_threshold_m=args.snap_threshold_m,
            time_gap_threshold_s=args.time_gap_threshold_s)
    except (MatchError, ValueError, OSError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
