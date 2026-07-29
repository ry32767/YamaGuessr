"""EXIF読み取り（exif.py）のテスト。

実機の写真は用意できないので、EXIF付きのJPEGを合成して読む。
"""
from __future__ import annotations

import struct
from datetime import datetime
from pathlib import Path

import pytest

import exif


# ---------------------------------------------------------------------------
# EXIF付きJPEGの合成
# ---------------------------------------------------------------------------
def _ifd_entry(tag: int, typ: int, count: int, payload: bytes) -> tuple[bytes, bytes]:
    """(12バイトのエントリ, 外部に置く実データ) を返す。実データは後で連結する。"""
    if len(payload) <= 4:
        return struct.pack(">HHI", tag, typ, count) + payload.ljust(4, b"\x00"), b""
    return struct.pack(">HHI", tag, typ, count) + b"\x00\x00\x00\x00", payload


def _build_ifd(entries: list[tuple[int, int, int, bytes]], base_offset: int,
               next_ifd: int = 0) -> bytes:
    """ビッグエンディアンのIFDを組み立てる。"""
    count = len(entries)
    header_size = 2 + count * 12 + 4
    data_offset = base_offset + header_size
    fixed: list[bytes] = []
    blobs: list[bytes] = []
    for tag, typ, num, payload in entries:
        if len(payload) <= 4:
            fixed.append(struct.pack(">HHI", tag, typ, num) + payload.ljust(4, b"\x00"))
        else:
            fixed.append(struct.pack(">HHI", tag, typ, num)
                         + struct.pack(">I", data_offset + sum(len(b) for b in blobs)))
            blobs.append(payload)
    return (struct.pack(">H", count) + b"".join(fixed)
            + struct.pack(">I", next_ifd) + b"".join(blobs))


def _rational(num: int, den: int) -> bytes:
    return struct.pack(">II", num, den)


def make_jpeg_with_exif(path: Path, taken: str = "2026:06:11 08:12:34",
                        offset: str | None = "+09:00",
                        lat: tuple[int, int, int] | None = None,
                        lon: tuple[int, int, int] | None = None) -> Path:
    """指定した撮影日時・GPSを持つ最小のJPEGを作る。"""
    # --- EXIF SubIFD ---
    sub_entries: list[tuple[int, int, int, bytes]] = [
        (exif.TAG_DATETIME_ORIGINAL, 2, len(taken) + 1, taken.encode() + b"\x00"),
    ]
    if offset is not None:
        sub_entries.append(
            (exif.TAG_OFFSET_TIME_ORIGINAL, 2, len(offset) + 1, offset.encode() + b"\x00"))

    # --- GPS IFD ---
    gps_entries: list[tuple[int, int, int, bytes]] = []
    if lat is not None and lon is not None:
        gps_entries = [
            (exif.GPS_LAT_REF, 2, 2, b"N\x00"),
            (exif.GPS_LAT, 5, 3, b"".join(_rational(v, 1) for v in lat)),
            (exif.GPS_LON_REF, 2, 2, b"E\x00"),
            (exif.GPS_LON, 5, 3, b"".join(_rational(v, 1) for v in lon)),
        ]

    # レイアウト: [TIFFヘッダ8][IFD0][SubIFD][GPS IFD]
    tiff_header = b"MM\x00*" + struct.pack(">I", 8)
    ifd0_entry_count = 2 + (1 if gps_entries else 0)
    ifd0_size = 2 + ifd0_entry_count * 12 + 4
    sub_offset = 8 + ifd0_size
    sub_bytes = _build_ifd(sub_entries, sub_offset)
    gps_offset = sub_offset + len(sub_bytes)
    gps_bytes = _build_ifd(gps_entries, gps_offset) if gps_entries else b""

    ifd0_entries: list[tuple[int, int, int, bytes]] = [
        (exif.TAG_ORIENTATION, 3, 1, struct.pack(">H", 1) + b"\x00\x00"),
        (exif.TAG_EXIF_IFD, 4, 1, struct.pack(">I", sub_offset)),
    ]
    if gps_entries:
        ifd0_entries.append((exif.TAG_GPS_IFD, 4, 1, struct.pack(">I", gps_offset)))
    ifd0_bytes = _build_ifd(ifd0_entries, 8)

    tiff = tiff_header + ifd0_bytes + sub_bytes + gps_bytes
    app1 = b"Exif\x00\x00" + tiff
    jpeg = (b"\xff\xd8"
            + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
            + b"\xff\xda" + struct.pack(">H", 2)   # SOS（中身は無くてよい）
            + b"\xff\xd9")
    path.write_bytes(jpeg)
    return path


# ---------------------------------------------------------------------------
# テスト
# ---------------------------------------------------------------------------
def test_reads_datetime_original(tmp_path: Path) -> None:
    p = make_jpeg_with_exif(tmp_path / "a.jpg")
    info = exif.read_exif(p)
    assert info.taken_local == datetime(2026, 6, 11, 8, 12, 34)
    assert info.utc_offset_minutes == 540
    assert info.orientation == 1


def test_taken_utc_uses_exif_offset(tmp_path: Path) -> None:
    p = make_jpeg_with_exif(tmp_path / "a.jpg", offset="+09:00")
    utc = exif.read_exif(p).taken_utc(default_offset_minutes=0)
    assert utc is not None
    assert utc.hour == 23 and utc.day == 10  # 08:12 JST = 前日 23:12 UTC


def test_taken_utc_falls_back_to_default_offset(tmp_path: Path) -> None:
    p = make_jpeg_with_exif(tmp_path / "a.jpg", offset=None)
    info = exif.read_exif(p)
    assert info.utc_offset_minutes is None
    utc = info.taken_utc(default_offset_minutes=540)
    assert utc is not None
    assert utc.hour == 23 and utc.day == 10


def test_reads_gps_when_present(tmp_path: Path) -> None:
    p = make_jpeg_with_exif(tmp_path / "a.jpg", lat=(34, 10, 49), lon=(136, 6, 33))
    info = exif.read_exif(p)
    assert info.lat == pytest.approx(34 + 10 / 60 + 49 / 3600, abs=1e-6)
    assert info.lon == pytest.approx(136 + 6 / 60 + 33 / 3600, abs=1e-6)


def test_no_gps_is_none(tmp_path: Path) -> None:
    info = exif.read_exif(make_jpeg_with_exif(tmp_path / "a.jpg"))
    assert info.lat is None and info.lon is None


def test_heic_is_rejected_with_guidance(tmp_path: Path) -> None:
    p = tmp_path / "IMG_0001.HEIC"
    p.write_bytes(b"\x00" * 32)
    with pytest.raises(exif.ExifError) as e:
        exif.read_exif(p)
    assert "JPEG" in str(e.value)


def test_non_image_is_rejected(tmp_path: Path) -> None:
    p = tmp_path / "notes.jpg"
    p.write_bytes(b"hello world")
    with pytest.raises(exif.ExifError):
        exif.read_exif(p)


def test_jpeg_without_exif_is_rejected(tmp_path: Path) -> None:
    p = tmp_path / "plain.jpg"
    p.write_bytes(b"\xff\xd8" + b"\xff\xda" + struct.pack(">H", 2) + b"\xff\xd9")
    with pytest.raises(exif.ExifError):
        exif.read_exif(p)
