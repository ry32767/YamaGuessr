"""テスト用の合成ルート（GPX）とテレメトリを作るヘルパ。

実際のGPXと登山動画がまだ無いため、既知の形のルートを合成して
照合ロジックの正しさを検証する。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Sequence

M_PER_DEG_LAT = 6371008.8 * math.pi / 180.0


def offset(lat: float, lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    """基準点から北・東にメートル移動した座標。"""
    d_lat = north_m / M_PER_DEG_LAT
    d_lon = east_m / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return lat + d_lat, lon + d_lon


def build_route(start_lat: float = 34.40, start_lon: float = 135.87,
                legs: Sequence[tuple[float, float]] = ((0.0, 200.0), (45.0, 200.0),
                                                       (90.0, 200.0)),
                step_m: float = 5.0) -> list[tuple[float, float, float]]:
    """(方位[deg], 距離[m]) の脚を繋いだルートを (lat, lon, 累積距離) で返す。"""
    pts: list[tuple[float, float, float]] = [(start_lat, start_lon, 0.0)]
    lat, lon, total = start_lat, start_lon, 0.0
    for bearing, length in legs:
        n = max(1, int(round(length / step_m)))
        for _ in range(n):
            rad = math.radians(bearing)
            lat, lon = offset(lat, lon, step_m * math.cos(rad), step_m * math.sin(rad))
            total += step_m
            pts.append((lat, lon, total))
    return pts


def write_gpx(path: Path, points: Sequence[tuple[float, float, float]],
              start: Optional[datetime] = None, speed_mps: float = 1.0,
              with_time: bool = True, with_ele: bool = True) -> Path:
    """ルートをGPXとして書き出す。時刻は一定速度で進んだものとする。"""
    start = start or datetime(2026, 7, 11, 3, 53, 58, tzinfo=timezone.utc)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">',
        '<trk><name>テストルート</name><trkseg>',
    ]
    for lat, lon, along in points:
        lines.append(f'<trkpt lat="{lat:.8f}" lon="{lon:.8f}">')
        if with_ele:
            lines.append(f'<ele>{200.0 + along * 0.1:.1f}</ele>')
        if with_time:
            t = start + timedelta(seconds=along / speed_mps)
            lines.append(f'<time>{t.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>')
        lines.append('</trkpt>')
    lines.append('</trkseg></trk></gpx>')
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def write_telemetry(path: Path, count: int, interval_us: int = 1_000_000,
                    gps: Optional[tuple[float, float]] = None,
                    gps_track: Optional[Sequence[tuple[float, float]]] = None,
                    quat_headings_deg: Optional[Sequence[float]] = None,
                    fps: float = 29.97) -> Path:
    """extract_telemetry.py 相当の JSON を書き出す。

    :param gps: 全フレームで同じ座標（GPSが固定される実機の挙動の再現）
    :param gps_track: フレーム毎の座標（GPSが生きている場合）
    :param quat_headings_deg: 各フレームのカメラ方位。NED・前方+x の規約で
                              その方位になるクォータニオンを埋め込む
    """
    rows = []
    for i in range(count):
        r: dict[str, object] = {
            "frame_index": i,
            "time_s": round(i / fps, 4),
            "capture_us": 1_000_000 + i * interval_us,
        }
        if gps_track is not None:
            lat, lon = gps_track[min(i, len(gps_track) - 1)]
            r["lat"], r["lon"] = lat, lon
        elif gps is not None:
            r["lat"], r["lon"] = gps
        if quat_headings_deg is not None:
            psi = math.radians(quat_headings_deg[min(i, len(quat_headings_deg) - 1)])
            # z 軸まわりの回転。NED（x=北, y=東, z=下）で +x を psi だけ回すと方位 psi
            r["quat_w"] = math.cos(psi / 2)
            r["quat_x"] = 0.0
            r["quat_y"] = 0.0
            r["quat_z"] = math.sin(psi / 2)
        rows.append(r)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return path


def write_summary(path: Path, start_local: str, video_name: str = "DJI_TEST.MP4") -> Path:
    """match_gpx.py が撮影開始時刻を拾うためのサマリJSON。"""
    path.write_text(json.dumps({
        "source": {"path": video_name, "filename": video_name, "start_local": start_local}
    }, ensure_ascii=False), encoding="utf-8")
    return path
