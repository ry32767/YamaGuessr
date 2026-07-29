"""GPX（登山ルートログ）の読み込み。

ヤマレコ／YAMAP／Garmin など出力元によって名前空間や構造が違うため、
名前空間を無視してタグ名だけで拾う。外部ライブラリには依存しない。
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple, Optional

from geo import LatLon, Polyline


class TrackPoint(NamedTuple):
    lat: float
    lon: float
    ele: Optional[float]
    time: Optional[datetime]
    """UTC の datetime（tz-aware）。時刻を持たないGPXでは None"""


class GpxTrack:
    """GPX から読んだトラック。折れ線としても時系列としても引ける。"""

    def __init__(self, points: list[TrackPoint], source: str = "") -> None:
        if len(points) < 2:
            raise ValueError("GPXのトラックポイントが2点未満です")
        self.points = points
        self.source = source
        self.polyline = Polyline([LatLon(p.lat, p.lon) for p in points])
        self._timed = [p for p in points if p.time is not None]

    @property
    def has_time(self) -> bool:
        """時刻照合に使えるだけの時刻情報があるか。"""
        return len(self._timed) >= 2

    @property
    def time_range(self) -> tuple[datetime, datetime]:
        if not self.has_time:
            raise ValueError("このGPXには時刻がありません")
        return self._timed[0].time, self._timed[-1].time  # type: ignore[return-value]

    def position_at(self, when: datetime) -> tuple[LatLon, float]:
        """指定時刻の位置を線形内挿で返す。

        :return: (座標, 最も近いトラックポイントとの時間差 [秒])
                 範囲外の時刻では端点にクランプし、時間差にその超過分が出る。
        """
        if not self.has_time:
            raise ValueError("このGPXには時刻がありません")
        pts = self._timed
        if when <= pts[0].time:  # type: ignore[operator]
            return LatLon(pts[0].lat, pts[0].lon), (pts[0].time - when).total_seconds()  # type: ignore[operator]
        if when >= pts[-1].time:  # type: ignore[operator]
            return LatLon(pts[-1].lat, pts[-1].lon), (when - pts[-1].time).total_seconds()  # type: ignore[operator]

        lo, hi = 0, len(pts) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if pts[mid].time <= when:  # type: ignore[operator]
                lo = mid
            else:
                hi = mid
        a, b = pts[lo], pts[lo + 1]
        span = (b.time - a.time).total_seconds()  # type: ignore[operator]
        t = 0.0 if span == 0 else (when - a.time).total_seconds() / span  # type: ignore[operator]
        lat = a.lat + t * (b.lat - a.lat)
        lon = a.lon + t * (b.lon - a.lon)
        gap = min(abs((when - a.time).total_seconds()),  # type: ignore[operator]
                  abs((b.time - when).total_seconds()))  # type: ignore[operator]
        return LatLon(lat, lon), gap


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_time(text: str) -> Optional[datetime]:
    """GPXの時刻文字列（ISO8601, 末尾Z）を tz-aware な UTC datetime にする。"""
    s = text.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def load_gpx(path: str | Path) -> GpxTrack:
    """GPX ファイルを読み、全 trkpt を1本のトラックとして返す。

    複数の trkseg / trk がある場合は出現順に連結する（分割ログの再結合）。
    trkpt が無い場合は rtept → wpt の順にフォールバックする。
    """
    root = ET.parse(str(path)).getroot()

    def collect(tag: str) -> list[TrackPoint]:
        out: list[TrackPoint] = []
        for el in root.iter():
            if _local_name(el.tag) != tag:
                continue
            lat_s, lon_s = el.get("lat"), el.get("lon")
            if lat_s is None or lon_s is None:
                continue
            ele: Optional[float] = None
            when: Optional[datetime] = None
            for child in el:
                name = _local_name(child.tag)
                if name == "ele" and child.text:
                    try:
                        ele = float(child.text)
                    except ValueError:
                        ele = None
                elif name == "time" and child.text:
                    when = _parse_time(child.text)
            out.append(TrackPoint(float(lat_s), float(lon_s), ele, when))
        return out

    for tag in ("trkpt", "rtept", "wpt"):
        pts = collect(tag)
        if len(pts) >= 2:
            return GpxTrack(pts, source=str(path))
    raise ValueError(f"{path} からトラックポイントを2点以上読めませんでした")
