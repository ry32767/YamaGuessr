"""幾何計算のヘルパ（距離・ローカル平面投影・折れ線へのスナップ・方位）。

出題対象は数km四方の山域なので、緯度経度はローカルな等距離円筒図法で
メートル平面に落として扱う（この範囲なら誤差は無視できる）。
"""
from __future__ import annotations

import math
from typing import Iterable, NamedTuple, Optional, Sequence

#: 地球の平均半径 [m]（WGS84の平均。src/scoring.ts と揃えること）
EARTH_RADIUS_M = 6371008.8


class LatLon(NamedTuple):
    lat: float
    lon: float


def haversine_m(a: LatLon, b: LatLon) -> float:
    """2地点間の大円距離 [m]。"""
    d_lat = math.radians(b.lat - a.lat)
    d_lon = math.radians(b.lon - a.lon)
    lat1 = math.radians(a.lat)
    lat2 = math.radians(b.lat)
    h = (math.sin(d_lat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: LatLon, b: LatLon) -> float:
    """a から b への進行方位 [deg]（真北基準・時計回り、0〜360）。"""
    lat1 = math.radians(a.lat)
    lat2 = math.radians(b.lat)
    d_lon = math.radians(b.lon - a.lon)
    y = math.sin(d_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff_deg(a: float, b: float) -> float:
    """2つの方位の差 [deg]（-180〜180）。"""
    return (a - b + 180.0) % 360.0 - 180.0


class LocalPlane:
    """基準点まわりのメートル平面（x=東, y=北）。"""

    def __init__(self, lat0: float, lon0: float) -> None:
        self.lat0 = lat0
        self.lon0 = lon0
        self._m_per_deg_lat = EARTH_RADIUS_M * math.pi / 180.0
        self._m_per_deg_lon = self._m_per_deg_lat * math.cos(math.radians(lat0))

    def to_xy(self, lat: float, lon: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self._m_per_deg_lon,
                (lat - self.lat0) * self._m_per_deg_lat)

    def to_latlon(self, x: float, y: float) -> LatLon:
        return LatLon(self.lat0 + y / self._m_per_deg_lat,
                      self.lon0 + x / self._m_per_deg_lon)


class SnapResult(NamedTuple):
    """折れ線へのスナップ結果。"""
    lat: float
    lon: float
    distance_m: float
    """元の点からスナップ先までの距離 [m]"""
    segment_index: int
    along_m: float
    """折れ線の始点からスナップ先までの経路長 [m]"""


class Polyline:
    """メートル平面に落とした折れ線。最近傍点へのスナップを提供する。"""

    def __init__(self, points: Sequence[LatLon]) -> None:
        if len(points) < 2:
            raise ValueError("折れ線には2点以上必要です")
        self.points = list(points)
        self.plane = LocalPlane(points[0].lat, points[0].lon)
        self.xy = [self.plane.to_xy(p.lat, p.lon) for p in self.points]
        self.cum: list[float] = [0.0]
        for i in range(1, len(self.xy)):
            x0, y0 = self.xy[i - 1]
            x1, y1 = self.xy[i]
            self.cum.append(self.cum[-1] + math.hypot(x1 - x0, y1 - y0))

    @property
    def length_m(self) -> float:
        return self.cum[-1]

    def bbox(self) -> tuple[float, float, float, float]:
        """(min_lat, min_lon, max_lat, max_lon)"""
        lats = [p.lat for p in self.points]
        lons = [p.lon for p in self.points]
        return min(lats), min(lons), max(lats), max(lons)

    def bbox_diagonal_m(self) -> float:
        min_lat, min_lon, max_lat, max_lon = self.bbox()
        return haversine_m(LatLon(min_lat, min_lon), LatLon(max_lat, max_lon))

    def snap(self, lat: float, lon: float, hint_index: Optional[int] = None,
             window: int = 200) -> SnapResult:
        """最近傍の線分上の点を返す。

        テレメトリはルート順に並ぶため、前回の線分番号を ``hint_index`` に渡すと
        その周辺だけを探索して O(1) に近づける。窓の外に本当の最近傍がある場合に
        備え、窓内の最良値が窓の端に来たときは全探索に切り替える。
        """
        px, py = self.plane.to_xy(lat, lon)
        n = len(self.xy) - 1

        def search(lo: int, hi: int) -> tuple[float, int, float]:
            best = (math.inf, 0, 0.0)
            for i in range(lo, hi):
                x0, y0 = self.xy[i]
                x1, y1 = self.xy[i + 1]
                dx, dy = x1 - x0, y1 - y0
                seg_len2 = dx * dx + dy * dy
                t = 0.0 if seg_len2 == 0 else ((px - x0) * dx + (py - y0) * dy) / seg_len2
                t = max(0.0, min(1.0, t))
                cx, cy = x0 + t * dx, y0 + t * dy
                d2 = (px - cx) ** 2 + (py - cy) ** 2
                if d2 < best[0]:
                    best = (d2, i, t)
            return best

        if hint_index is None:
            d2, idx, t = search(0, n)
        else:
            lo = max(0, hint_index - window)
            hi = min(n, hint_index + window)
            d2, idx, t = search(lo, hi)
            # 窓の端が最良なら、窓の外にもっと近い場所がある可能性が高い
            if idx <= lo or idx >= hi - 1:
                d2, idx, t = search(0, n)

        x0, y0 = self.xy[idx]
        x1, y1 = self.xy[idx + 1]
        cx, cy = x0 + t * (x1 - x0), y0 + t * (y1 - y0)
        snapped = self.plane.to_latlon(cx, cy)
        along = self.cum[idx] + math.hypot(cx - x0, cy - y0)
        return SnapResult(snapped.lat, snapped.lon, math.sqrt(d2), idx, along)

    def point_at(self, along_m: float) -> LatLon:
        """始点から ``along_m`` 進んだ位置の座標。"""
        if along_m <= 0:
            return self.points[0]
        if along_m >= self.length_m:
            return self.points[-1]
        lo, hi = 0, len(self.cum) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if self.cum[mid] <= along_m:
                lo = mid
            else:
                hi = mid
        seg = self.cum[lo + 1] - self.cum[lo]
        t = 0.0 if seg == 0 else (along_m - self.cum[lo]) / seg
        x0, y0 = self.xy[lo]
        x1, y1 = self.xy[lo + 1]
        return self.plane.to_latlon(x0 + t * (x1 - x0), y0 + t * (y1 - y0))


# ---------------------------------------------------------------------------
# クォータニオン → カメラ方位
# ---------------------------------------------------------------------------
#: 機体座標系での「カメラ前方」候補
AXES: dict[str, tuple[float, float, float]] = {
    "x": (1.0, 0.0, 0.0), "-x": (-1.0, 0.0, 0.0),
    "y": (0.0, 1.0, 0.0), "-y": (0.0, -1.0, 0.0),
    "z": (0.0, 0.0, 1.0), "-z": (0.0, 0.0, -1.0),
}

#: 世界座標系の規約。値は (北成分の軸, 東成分の軸) をベクトル添字で表す
WORLD_CONVENTIONS: dict[str, tuple[int, int, float, float]] = {
    # NED: x=北, y=東
    "ned": (0, 1, 1.0, 1.0),
    # ENU: x=東, y=北
    "enu": (1, 0, 1.0, 1.0),
    # NWU: x=北, y=西（東は符号反転）
    "nwu": (0, 1, 1.0, -1.0),
}


def rotate_by_quat(q: tuple[float, float, float, float],
                   v: tuple[float, float, float]) -> tuple[float, float, float]:
    """クォータニオン (w, x, y, z) でベクトルを回転する。"""
    w, x, y, z = q
    vx, vy, vz = v
    # t = 2 * (q_vec × v)
    tx = 2.0 * (y * vz - z * vy)
    ty = 2.0 * (z * vx - x * vz)
    tz = 2.0 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def quat_to_heading_deg(q: tuple[float, float, float, float],
                        forward: str = "x", world: str = "ned") -> float:
    """クォータニオンからカメラ方位 [deg]（真北基準・時計回り、0〜360）を求める。

    DJIのクォータニオンの座標系規約は公開されていないため、
    前方軸と世界座標系の規約を引数で差し替えられるようにしてある。
    実データで進行方位と突き合わせて確定させること（docs/spec.md 機能A-2）。
    """
    if forward not in AXES:
        raise ValueError(f"未知の前方軸: {forward}")
    if world not in WORLD_CONVENTIONS:
        raise ValueError(f"未知の世界座標系: {world}")
    v = rotate_by_quat(q, AXES[forward])
    n_i, e_i, n_sign, e_sign = WORLD_CONVENTIONS[world]
    north = v[n_i] * n_sign
    east = v[e_i] * e_sign
    return (math.degrees(math.atan2(east, north)) + 360.0) % 360.0


def normalize_quat(q: tuple[float, float, float, float]
                   ) -> tuple[float, float, float, float]:
    n = math.sqrt(sum(c * c for c in q))
    if n == 0:
        raise ValueError("ゼロクォータニオンは正規化できません")
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n)


def circular_mean_deg(angles: Iterable[float]) -> float:
    """角度の円周平均 [deg]（0〜360）。"""
    xs = ys = 0.0
    count = 0
    for a in angles:
        r = math.radians(a)
        xs += math.cos(r)
        ys += math.sin(r)
        count += 1
    if count == 0:
        raise ValueError("空の系列の平均は取れません")
    return (math.degrees(math.atan2(ys, xs)) + 360.0) % 360.0
