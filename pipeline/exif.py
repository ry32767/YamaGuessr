"""JPEG/TIFF の EXIF から撮影日時と位置を読む。

スマホで撮った写真を出題地点にするために使う。必要なのは
「いつ撮ったか」（GPXと突き合わせる鍵）と、あれば「どこで撮ったか」だけなので、
汎用の画像ライブラリは入れずに EXIF の該当タグだけを読む。

HEIC（iPhoneの既定形式）はコンテナが別物なので読めない。JPEGに変換してから渡す。
"""
from __future__ import annotations

import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NamedTuple, Optional

#: 読み出す EXIF タグ
TAG_DATETIME = 0x0132           # ファイル変更日時（フォールバック）
TAG_DATETIME_ORIGINAL = 0x9003  # 撮影日時
TAG_DATETIME_DIGITIZED = 0x9004
TAG_OFFSET_TIME_ORIGINAL = 0x9011  # 撮影時のUTCオフセット（"+09:00"）
TAG_EXIF_IFD = 0x8769
TAG_GPS_IFD = 0x8825
TAG_ORIENTATION = 0x0112

GPS_LAT_REF = 0x0001
GPS_LAT = 0x0002
GPS_LON_REF = 0x0003
GPS_LON = 0x0004
GPS_ALT_REF = 0x0005
GPS_ALT = 0x0006

#: 型ごとのバイト長
TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8}

JPEG_SUFFIXES = {".jpg", ".jpeg", ".JPG", ".JPEG"}
TIFF_SUFFIXES = {".tif", ".tiff", ".TIF", ".TIFF"}
#: 読めないが、よく渡される形式（案内を出すため）
UNSUPPORTED_SUFFIXES = {".heic", ".HEIC", ".heif", ".HEIF"}


class ExifError(RuntimeError):
    """EXIF を読めなかった。"""


class PhotoExif(NamedTuple):
    """写真から読めた情報。"""
    taken_local: Optional[datetime]
    """撮影日時。タイムゾーンを持たない素の日時（EXIFの既定）"""
    utc_offset_minutes: Optional[int]
    """EXIF が持っていた場合のUTCオフセット [分]"""
    lat: Optional[float]
    lon: Optional[float]
    altitude_m: Optional[float]
    orientation: Optional[int]

    def taken_utc(self, default_offset_minutes: int) -> Optional[datetime]:
        """撮影日時をUTCにする。EXIFにオフセットが無ければ既定値を使う。"""
        if self.taken_local is None:
            return None
        offset = self.utc_offset_minutes
        if offset is None:
            offset = default_offset_minutes
        tz = timezone(timedelta(minutes=offset))
        return self.taken_local.replace(tzinfo=tz).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# TIFF ヘッダの読み取り
# ---------------------------------------------------------------------------
def _read_ifd(buf: bytes, base: int, offset: int, endian: str,
              depth: int = 0) -> dict[int, Any]:
    """1つのIFDを {tag: value} で返す。入れ子のIFDも辿る。"""
    out: dict[int, Any] = {}
    if depth > 3 or base + offset + 2 > len(buf):
        return out
    pos = base + offset
    count = struct.unpack_from(endian + "H", buf, pos)[0]
    pos += 2
    for _ in range(count):
        if pos + 12 > len(buf):
            break
        tag, typ, num = struct.unpack_from(endian + "HHI", buf, pos)
        value_offset = pos + 8
        size = TYPE_SIZES.get(typ, 0) * num
        if size == 0:
            pos += 12
            continue
        if size > 4:
            (rel,) = struct.unpack_from(endian + "I", buf, value_offset)
            value_offset = base + rel
        if value_offset + size > len(buf):
            pos += 12
            continue
        out[tag] = _read_value(buf, value_offset, typ, num, endian)
        pos += 12

    for tag in (TAG_EXIF_IFD, TAG_GPS_IFD):
        sub = out.get(tag)
        if isinstance(sub, int):
            nested = _read_ifd(buf, base, sub, endian, depth + 1)
            for k, v in nested.items():
                # GPS の IFD はタグ番号が他と衝突するので接頭辞で分ける
                out[(k | 0x10000) if tag == TAG_GPS_IFD else k] = v
    return out


def _read_value(buf: bytes, offset: int, typ: int, num: int, endian: str) -> Any:
    if typ == 2:  # ASCII
        raw = buf[offset:offset + num]
        return raw.split(b"\x00")[0].decode("latin1", "replace")
    if typ in (1, 7):  # BYTE / UNDEFINED
        return buf[offset:offset + num]
    fmt = {3: "H", 4: "I", 9: "i"}.get(typ)
    if fmt:
        values = struct.unpack_from(endian + fmt * num, buf, offset)
        return values[0] if num == 1 else list(values)
    if typ in (5, 10):  # RATIONAL / SRATIONAL
        fmt = "II" if typ == 5 else "ii"
        values = struct.unpack_from(endian + fmt * num, buf, offset)
        pairs = [(values[i], values[i + 1]) for i in range(0, len(values), 2)]
        rationals = [(n / d if d else 0.0) for n, d in pairs]
        return rationals[0] if num == 1 else rationals
    return None


def _find_tiff_block(data: bytes, path: Path) -> tuple[bytes, int]:
    """EXIF の TIFF ブロックと、その先頭位置を返す。"""
    if path.suffix in TIFF_SUFFIXES or data[:4] in (b"II*\x00", b"MM\x00*"):
        return data, 0
    if data[:2] != b"\xff\xd8":
        raise ExifError(f"{path.name} はJPEG/TIFFではありません")
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            break
        marker = data[pos + 1]
        if marker in (0xD8, 0xD9):
            pos += 2
            continue
        (length,) = struct.unpack_from(">H", data, pos + 2)
        if marker == 0xE1 and data[pos + 4:pos + 10] == b"Exif\x00\x00":
            return data, pos + 10
        if marker == 0xDA:  # 画像データに入ったら以降にEXIFは無い
            break
        pos += 2 + length
    raise ExifError(f"{path.name} にEXIFがありません")


def _to_degrees(rationals: Any, ref: Any) -> Optional[float]:
    if not isinstance(rationals, list) or len(rationals) < 3:
        return None
    deg, minute, sec = rationals[0], rationals[1], rationals[2]
    value = deg + minute / 60.0 + sec / 3600.0
    if isinstance(ref, str) and ref.upper().startswith(("S", "W")):
        value = -value
    return value


def _parse_datetime(text: Any) -> Optional[datetime]:
    """EXIF の "2026:06:11 08:12:34" 形式を datetime にする。"""
    if not isinstance(text, str):
        return None
    try:
        return datetime.strptime(text.strip(), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _parse_offset(text: Any) -> Optional[int]:
    """"+09:00" を分に直す。"""
    if not isinstance(text, str) or len(text) < 6:
        return None
    sign = 1 if text[0] == "+" else -1 if text[0] == "-" else None
    if sign is None:
        return None
    try:
        hours = int(text[1:3])
        minutes = int(text[4:6])
    except ValueError:
        return None
    return sign * (hours * 60 + minutes)


def read_exif(path: str | Path) -> PhotoExif:
    """写真から撮影日時・位置を読む。"""
    p = Path(path)
    if p.suffix in UNSUPPORTED_SUFFIXES:
        raise ExifError(
            f"{p.name} はHEIC/HEIF形式で読めません。JPEGに変換してから渡してください"
        )
    data = p.read_bytes()
    block, base = _find_tiff_block(data, p)
    if block[base:base + 2] == b"II":
        endian = "<"
    elif block[base:base + 2] == b"MM":
        endian = ">"
    else:
        raise ExifError(f"{p.name} のEXIFヘッダを解釈できません")
    (first_ifd,) = struct.unpack_from(endian + "I", block, base + 4)
    tags = _read_ifd(block, base, first_ifd, endian)

    taken = (_parse_datetime(tags.get(TAG_DATETIME_ORIGINAL))
             or _parse_datetime(tags.get(TAG_DATETIME_DIGITIZED))
             or _parse_datetime(tags.get(TAG_DATETIME)))
    offset = _parse_offset(tags.get(TAG_OFFSET_TIME_ORIGINAL))

    lat = _to_degrees(tags.get(GPS_LAT | 0x10000), tags.get(GPS_LAT_REF | 0x10000))
    lon = _to_degrees(tags.get(GPS_LON | 0x10000), tags.get(GPS_LON_REF | 0x10000))
    altitude = tags.get(GPS_ALT | 0x10000)
    if isinstance(altitude, (int, float)) and tags.get(GPS_ALT_REF | 0x10000) == 1:
        altitude = -float(altitude)
    orientation = tags.get(TAG_ORIENTATION)

    return PhotoExif(
        taken_local=taken,
        utc_offset_minutes=offset,
        lat=lat,
        lon=lon,
        altitude_m=float(altitude) if isinstance(altitude, (int, float)) else None,
        orientation=int(orientation) if isinstance(orientation, int) else None,
    )
