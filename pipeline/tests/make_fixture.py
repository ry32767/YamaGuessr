#!/usr/bin/env python3
"""実動画から djmd サンプルだけを抜き出し、小さなテスト用 MP4 を作る。

実動画（数十MB〜数GB）はリポジトリに入れられないため、
テレメトリトラックだけを取り出した数十KBの MP4 を fixture としてコミットする。

**fixture は公開リポジトリに入る。** 実際の測位座標をそのまま残すと、
撮影者がいた場所が公開されてしまう。既定でGPS座標をダミー値に置き換える。

使い方::

    python pipeline/tests/make_fixture.py Source/DJI_xxx.MP4 \\
        -o pipeline/tests/fixtures/sample_djmd.mp4 -n 120
"""
from __future__ import annotations

import argparse
import mmap
import struct
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import extract_telemetry as et  # noqa: E402
from mp4_builder import build_djmd_mp4  # noqa: E402

#: 公開しても差し支えない、明らかに合成と分かるダミー座標
DUMMY_LAT = 34.0
DUMMY_LON = 135.0


def scrub_gps(sample: bytes, real_lat: float, real_lon: float,
              lat: float = DUMMY_LAT, lon: float = DUMMY_LON) -> bytes:
    """サンプル内の緯度経度（f64）をダミー値に差し替える。

    protobuf の fixed64 は固定長なので、バイト列をそのまま置換すれば
    構造を壊さずに座標だけ消せる。
    """
    out = sample
    for real, dummy in ((real_lat, lat), (real_lon, lon)):
        out = out.replace(struct.pack("<d", real), struct.pack("<d", dummy))
    return out


def make_fixture(video: str, out: str, count: int, scrub: bool = True) -> Path:
    with open(video, "rb") as fp:
        mm = mmap.mmap(fp.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            traks = et.find_metadata_traks(mm)
            meta = next((t for t in traks if t["codec"] == "djmd"), None)
            if meta is None:
                raise et.TelemetryError("djmd トラックが見つかりません")
            samples: list[bytes] = []
            durations: list[int] = []
            real_lat: Optional[float] = None
            real_lon: Optional[float] = None
            for off, size, dur in et.iter_sample_table(
                    mm, meta["stbl_payload"], meta["stbl_end"]):
                raw = bytes(mm[off:off + size])
                if real_lat is None:
                    rec = et.decode_frame(raw)
                    real_lat = rec.get("lat")
                    real_lon = rec.get("lon")
                samples.append(raw)
                durations.append(dur)
                if len(samples) >= count:
                    break
            timescale = meta["timescale"] or 30000
        finally:
            mm.close()

    if scrub and real_lat is not None and real_lon is not None:
        samples = [scrub_gps(s, real_lat, real_lon) for s in samples]
        print(f"GPS座標をダミー値に置換しました → {DUMMY_LAT}, {DUMMY_LON}")

    data = build_djmd_mp4(samples, durations, timescale=timescale)
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    print(f"fixture 書き出し: {out_path} ({len(data)} bytes, {len(samples)} サンプル)")
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description="djmd のみの小さなテスト用 MP4 を作る")
    ap.add_argument("video", help="元の DJI 動画")
    ap.add_argument("-o", "--out", default="pipeline/tests/fixtures/sample_djmd.mp4")
    ap.add_argument("-n", "--count", type=int, default=120, help="残すサンプル数")
    ap.add_argument("--keep-gps", action="store_true",
                    help="実際のGPS座標を残す（公開リポジトリでは使わない）")
    args = ap.parse_args()
    make_fixture(args.video, args.out, args.count, scrub=not args.keep_gps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
