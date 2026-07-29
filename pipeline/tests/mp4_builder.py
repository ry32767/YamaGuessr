"""テスト用の最小 MP4（djmd メタデータトラックのみ）を組み立てるヘルパ。

実動画は数十〜数百MBあり fixture としてコミットできないため、
djmd サンプルだけを取り出した数十KBの MP4 を合成して回帰テストに使う。
"""
from __future__ import annotations

import struct
from typing import Optional, Sequence


def box(typ: bytes, payload: bytes) -> bytes:
    """size + type + payload の box を作る。"""
    return struct.pack(">I", len(payload) + 8) + typ + payload


def full_box(typ: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(typ, struct.pack(">B", version) + struct.pack(">I", flags)[1:] + payload)


_UNITY_MATRIX = struct.pack(
    ">9i", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000
)


def _mvhd(timescale: int, duration: int) -> bytes:
    payload = struct.pack(">IIII", 0, 0, timescale, duration)
    payload += struct.pack(">i", 0x00010000)   # rate
    payload += struct.pack(">h", 0x0100)       # volume
    payload += b"\x00" * 2                     # reserved
    payload += b"\x00" * 8                     # reserved
    payload += _UNITY_MATRIX
    payload += b"\x00" * 24                    # pre_defined
    payload += struct.pack(">I", 2)            # next_track_ID
    return full_box(b"mvhd", 0, 0, payload)


def _tkhd(track_id: int, duration: int) -> bytes:
    payload = struct.pack(">III", 0, 0, track_id)
    payload += b"\x00" * 4                     # reserved
    payload += struct.pack(">I", duration)
    payload += b"\x00" * 8                     # reserved
    payload += struct.pack(">hhhh", 0, 0, 0, 0)  # layer, altgroup, volume, reserved
    payload += _UNITY_MATRIX
    payload += struct.pack(">II", 0, 0)        # width, height (metadata track なので 0)
    return full_box(b"tkhd", 0, 7, payload)


def _mdhd(timescale: int, duration: int) -> bytes:
    payload = struct.pack(">IIII", 0, 0, timescale, duration)
    payload += struct.pack(">HH", 0x55C4, 0)   # language='und', pre_defined
    return full_box(b"mdhd", 0, 0, payload)


def _hdlr(handler_type: bytes, name: str) -> bytes:
    payload = struct.pack(">I", 0)             # pre_defined
    payload += handler_type
    payload += b"\x00" * 12                    # reserved
    payload += name.encode("latin1") + b"\x00"
    return full_box(b"hdlr", 0, 0, payload)


def _stsd(codec: bytes) -> bytes:
    entry = struct.pack(">I", 16) + codec + b"\x00" * 6 + struct.pack(">H", 1)
    payload = struct.pack(">I", 1) + entry
    return full_box(b"stsd", 0, 0, payload)


def _stts(durations: Sequence[int]) -> bytes:
    """連続する同一 duration を run-length にまとめる。"""
    runs: list[tuple[int, int]] = []
    for d in durations:
        if runs and runs[-1][1] == d:
            runs[-1] = (runs[-1][0] + 1, d)
        else:
            runs.append((1, d))
    payload = struct.pack(">I", len(runs))
    for cnt, d in runs:
        payload += struct.pack(">II", cnt, d)
    return full_box(b"stts", 0, 0, payload)


def _stsc(entries: Sequence[tuple[int, int, int]]) -> bytes:
    payload = struct.pack(">I", len(entries))
    for first_chunk, spc, desc in entries:
        payload += struct.pack(">III", first_chunk, spc, desc)
    return full_box(b"stsc", 0, 0, payload)


def _stsz(sizes: Sequence[int]) -> bytes:
    payload = struct.pack(">II", 0, len(sizes))
    for s in sizes:
        payload += struct.pack(">I", s)
    return full_box(b"stsz", 0, 0, payload)


def _stco(offsets: Sequence[int], use_co64: bool) -> bytes:
    if use_co64:
        payload = struct.pack(">I", len(offsets))
        for o in offsets:
            payload += struct.pack(">Q", o)
        return full_box(b"co64", 0, 0, payload)
    payload = struct.pack(">I", len(offsets))
    for o in offsets:
        payload += struct.pack(">I", o)
    return full_box(b"stco", 0, 0, payload)


def build_djmd_mp4(samples: Sequence[bytes],
                   durations: Optional[Sequence[int]] = None,
                   timescale: int = 30000,
                   samples_per_chunk: int = 0,
                   use_co64: bool = False,
                   handler_name: str = "CAM meta",
                   codec: bytes = b"djmd") -> bytes:
    """djmd トラック 1 本だけの MP4 バイト列を返す。

    :param samples: 各サンプルの protobuf バイト列
    :param durations: 各サンプルの duration（timescale 単位）。省略時は 1001 固定
    :param samples_per_chunk: 0 なら全サンプルを 1 チャンクに詰める
    :param use_co64: True なら stco ではなく co64 を使う
    """
    if durations is None:
        durations = [1001] * len(samples)
    if len(durations) != len(samples):
        raise ValueError("durations と samples の長さが一致しません")

    sizes = [len(s) for s in samples]
    spc = samples_per_chunk or max(len(samples), 1)
    n_chunks = max(1, (len(samples) + spc - 1) // spc)
    total_duration = sum(durations)

    def assemble(chunk_offsets: Sequence[int]) -> bytes:
        stbl = box(b"stbl",
                   _stsd(codec)
                   + _stts(durations)
                   + _stsc([(1, spc, 1)])
                   + _stsz(sizes)
                   + _stco(chunk_offsets, use_co64))
        dinf = box(b"dinf", full_box(b"dref", 0, 0,
                                     struct.pack(">I", 1) + full_box(b"url ", 0, 1, b"")))
        minf = box(b"minf", full_box(b"nmhd", 0, 0, b"") + dinf + stbl)
        mdia = box(b"mdia", _mdhd(timescale, total_duration)
                   + _hdlr(b"meta", handler_name) + minf)
        trak = box(b"trak", _tkhd(1, total_duration) + mdia)
        moov = box(b"moov", _mvhd(timescale, total_duration) + trak)
        ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2mp41")
        mdat = box(b"mdat", b"".join(samples))
        return ftyp + moov + mdat

    # チャンクオフセットは moov のサイズに依存するので、仮値で組んでから実値で組み直す。
    placeholder = [0] * n_chunks
    provisional = assemble(placeholder)
    mdat_data_start = len(provisional) - sum(sizes)

    offsets: list[int] = []
    pos = mdat_data_start
    for ci in range(n_chunks):
        offsets.append(pos)
        for si in range(ci * spc, min((ci + 1) * spc, len(samples))):
            pos += sizes[si]

    result = assemble(offsets)
    assert len(result) == len(provisional), "moov のサイズが仮組みと変わりました"
    return result
