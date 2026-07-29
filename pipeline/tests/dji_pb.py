"""テスト用に DJI(dvtm_ac206) 形式のテレメトリ protobuf サンプルを合成するヘルパ。

実機が無い条件（タイムラプス、GPS 欠落など）を再現するために、
`extract_telemetry.decode_frame` が読む構造と同じものをこちらから組み立てる。
"""
from __future__ import annotations

import struct
from typing import Optional


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_varint(field: int, value: int) -> bytes:
    return _key(field, 0) + _varint(value)


def pb_f32(field: int, value: float) -> bytes:
    return _key(field, 5) + struct.pack("<f", value)


def pb_f64(field: int, value: float) -> bytes:
    return _key(field, 1) + struct.pack("<d", value)


def pb_bytes(field: int, value: bytes) -> bytes:
    return _key(field, 2) + _varint(len(value)) + value


def pb_msg(field: int, payload: bytes) -> bytes:
    return pb_bytes(field, payload)


def make_sample(frame_index: int,
                capture_us: int,
                lat: Optional[float] = None,
                lon: Optional[float] = None,
                altitude_mm: Optional[int] = None,
                datetime_gps: Optional[str] = None,
                quat: tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0),
                acc_h: Optional[float] = None,
                acc_v: Optional[float] = None) -> bytes:
    """1 フレーム分の djmd サンプル（protobuf）を組み立てる。"""
    # top #3 #1 : フレーム情報
    finfo = b""
    if frame_index:
        finfo += pb_varint(1, frame_index)
    finfo += pb_varint(2, capture_us)

    # top #3 #2 : ブロックA（IMU）
    quat_msg = (pb_f32(1, quat[0]) + pb_f32(2, quat[1])
                + pb_f32(3, quat[2]) + pb_f32(4, quat[3]))
    blk_a = pb_msg(3, pb_f32(1, 200.0)) + pb_msg(9, quat_msg)

    # top #3 #4 : ブロックB（GPS）
    blk_b = b""
    b2 = b""
    if lat is not None and lon is not None:
        b2 += pb_msg(1, pb_varint(1, 1) + pb_f64(2, lat) + pb_f64(3, lon))
    if altitude_mm is not None:
        b2 += pb_varint(2, altitude_mm)
    if datetime_gps is not None:
        b2 += pb_msg(6, pb_bytes(1, datetime_gps.encode("latin1")))
    if b2:
        blk_b += pb_msg(2, b2)
    if acc_h is not None or acc_v is not None:
        b3 = b""
        if acc_h is not None:
            b3 += pb_f32(1, acc_h)
        if acc_v is not None:
            b3 += pb_f32(2, acc_v)
        blk_b += pb_msg(3, b3)

    m3 = pb_msg(1, finfo) + pb_msg(2, blk_a)
    if blk_b:
        m3 += pb_msg(4, blk_b)
    return pb_msg(3, m3)


def make_header_sample(model: str = "DJI OsmoAction6",
                       width: int = 3840,
                       height: int = 2160,
                       fps: float = 29.97) -> bytes:
    """先頭サンプルに付く機器情報ヘッダ（top #1 / #2）を組み立てる。"""
    dev1 = (pb_bytes(1, b"dvtm_ac206.proto")
            + pb_bytes(3, b"2.0.1")
            + pb_bytes(5, b"TESTSERIAL0001")
            + pb_bytes(6, b"10.00.34.29")
            + pb_bytes(10, model.encode("latin1")))
    top1 = pb_msg(1, pb_msg(1, dev1))
    v3 = pb_varint(1, width) + pb_varint(2, height) + pb_f32(3, fps)
    top2 = pb_msg(2, pb_msg(3, v3))
    return top1 + top2
