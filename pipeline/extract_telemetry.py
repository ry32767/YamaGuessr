#!/usr/bin/env python3
"""DJI 動画（Osmo Action 6 / dvtm_ac206.proto 形式）からテレメトリを抽出する。

DJI の新しめのカメラは、旧来のサイドカー .SRT ではなく MP4 内の
timed-metadata トラック（handler="CAM meta", codec="djmd"）に protobuf 形式で
フレーム毎のテレメトリを埋め込む。本スクリプトは外部ツール(ffmpeg/exiftool)無しで
純Pythonだけで解析する。

数時間のタイムラプス（＝数GB・数十万フレーム）を想定し、
ファイルは mmap で読み、サンプルはジェネレータで逐次処理する（全読み込みしない）。

使い方::

    python pipeline/extract_telemetry.py Source/DJI_xxx.MP4
    python pipeline/extract_telemetry.py Source/DJI_xxx.MP4 \\
        -o pipeline/data/telemetry.csv \\
        --json pipeline/data/telemetry.json \\
        --summary pipeline/data/telemetry_summary.json

出力: 1行=1フレームのCSV（time_s, capture_us, datetime_gps, lat, lon,
      altitude_m, quat_w/x/y/z, ...）と、動画全体のサマリJSON。
"""
from __future__ import annotations

import argparse
import csv
import json
import mmap
import re
import struct
import sys
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator, Optional

# ---------------------------------------------------------------------------
# 出力する列（この順で CSV に並ぶ）
# ---------------------------------------------------------------------------
COLUMNS: list[str] = [
    "frame_index",
    "time_s",
    "capture_us",
    "datetime_gps",
    "lat",
    "lon",
    "altitude_m",
    "gps_acc_h_m",
    "gps_acc_v_m",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "vec_x",
    "vec_y",
    "vec_z",
    "iso",
    "shutter_raw",
]

# ---------------------------------------------------------------------------
# MP4 (ISO BMFF) box parsing
# ---------------------------------------------------------------------------
CONTAINER_BOXES: set[bytes] = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts",
}


def iter_boxes(buf: Any, start: int, end: int) -> Iterator[tuple[bytes, int, int, int]]:
    """指定範囲の直下の box を (type, box_start, box_size, payload_start) で返す。"""
    off = start
    while off + 8 <= end:
        size = struct.unpack_from(">I", buf, off)[0]
        typ = bytes(buf[off + 4:off + 8])
        header = 8
        if size == 1:  # 64bit size
            size = struct.unpack_from(">Q", buf, off + 8)[0]
            header = 16
        elif size == 0:  # 末尾まで
            size = end - off
        yield typ, off, size, off + header
        if size <= 0:
            break
        off += size


def find_all(buf: Any, typ: bytes, start: int = 0,
             end: Optional[int] = None) -> list[tuple[int, int, int]]:
    """再帰的に指定 type の box を全部見つける。"""
    if end is None:
        end = len(buf)
    found: list[tuple[int, int, int]] = []
    for t, o, s, p in iter_boxes(buf, start, end):
        if t == typ:
            found.append((o, s, p))
        if t in CONTAINER_BOXES:
            found += find_all(buf, typ, p, o + s)
    return found


def get_child(buf: Any, parent_payload: int, parent_end: int,
              typ: bytes) -> Optional[tuple[int, int, int]]:
    for t, o, s, p in iter_boxes(buf, parent_payload, parent_end):
        if t == typ:
            return o, s, p
    return None


# ---------------------------------------------------------------------------
# トラック探索: handler / codec からメタデータトラックを見つける
# ---------------------------------------------------------------------------
def find_metadata_traks(buf: Any) -> list[dict[str, Any]]:
    """(handler, codec, stbl_payload, stbl_end, timescale) のリストを返す。"""
    result: list[dict[str, Any]] = []
    for o, s, p in find_all(buf, b"trak"):
        trak_end = o + s
        mdia = get_child(buf, p, trak_end, b"mdia")
        if not mdia:
            continue
        mo, ms, mp = mdia
        mdia_end = mo + ms
        # hdlr -> handler name
        hdlr = get_child(buf, mp, mdia_end, b"hdlr")
        handler_name = ""
        if hdlr:
            ho, hs, hp = hdlr
            hdata = bytes(buf[hp:ho + hs])
            handler_name = hdata[24:].split(b"\x00")[0].decode("latin1", "replace")
        # mdhd -> timescale
        mdhd = get_child(buf, mp, mdia_end, b"mdhd")
        timescale = None
        if mdhd:
            do, ds, dp = mdhd
            timescale = struct.unpack_from(">I", buf, dp + 12)[0]
        # minf/stbl
        minf = get_child(buf, mp, mdia_end, b"minf")
        if not minf:
            continue
        io, is_, ip = minf
        stbl = get_child(buf, ip, io + is_, b"stbl")
        if not stbl:
            continue
        bo, bs, bp = stbl
        # codec (stsd 内の先頭エントリ type)
        stsd = get_child(buf, bp, bo + bs, b"stsd")
        codec = ""
        if stsd:
            so, ss, sp = stsd
            # stsd payload: ver/flags(4)+count(4)+entry_size(4)+format(4)
            codec = bytes(buf[sp + 12:sp + 16]).decode("latin1", "replace")
        result.append({
            "handler": handler_name, "codec": codec,
            "stbl_payload": bp, "stbl_end": bo + bs, "timescale": timescale,
        })
    return result


def iter_sample_table(buf: Any, stbl_payload: int,
                      stbl_end: int) -> Iterator[tuple[int, int, int]]:
    """stsz/stco/stsc/stts から各サンプルの (file_offset, size, duration) を逐次復元。

    数十万サンプルになりうるため、オフセット配列を一度に組み立てずに yield する。
    """
    def child(t: bytes) -> tuple[int, int, int]:
        c = get_child(buf, stbl_payload, stbl_end, t)
        if c is None:
            raise ValueError(f"stbl に {t.decode()} box がありません")
        return c

    # stsz: サンプルサイズ
    _o, _s, p = child(b"stsz")
    uniform_size = struct.unpack_from(">I", buf, p + 4)[0]
    count = struct.unpack_from(">I", buf, p + 8)[0]
    stsz_payload = p

    def sample_size(i: int) -> int:
        if uniform_size:
            return int(uniform_size)
        return int(struct.unpack_from(">I", buf, stsz_payload + 12 + 4 * i)[0])

    # chunk offsets (stco / co64)
    co = get_child(buf, stbl_payload, stbl_end, b"stco")
    if co:
        _o, _s, p = co
        n_chunks = struct.unpack_from(">I", buf, p + 4)[0]
        chunk_offsets = [struct.unpack_from(">I", buf, p + 8 + 4 * i)[0]
                         for i in range(n_chunks)]
    else:
        _o, _s, p = child(b"co64")
        n_chunks = struct.unpack_from(">I", buf, p + 4)[0]
        chunk_offsets = [struct.unpack_from(">Q", buf, p + 8 + 8 * i)[0]
                         for i in range(n_chunks)]

    # stsc: sample-to-chunk（区間表のまま持ち、チャンク毎に引く）
    _o, _s, p = child(b"stsc")
    n_stsc = struct.unpack_from(">I", buf, p + 4)[0]
    stsc = [struct.unpack_from(">III", buf, p + 8 + 12 * i) for i in range(n_stsc)]

    def samples_in_chunk(chunk_index0: int) -> int:
        """0始まりのチャンク番号に対するサンプル数を stsc の区間表から引く。"""
        spc = stsc[0][1] if stsc else 1
        for first, s_per_chunk, _desc in stsc:
            if chunk_index0 + 1 >= first:
                spc = s_per_chunk
            else:
                break
        return int(spc)

    # stts: 各サンプルの duration（run-length のまま保持）
    _o, _s, p = child(b"stts")
    n_stts = struct.unpack_from(">I", buf, p + 4)[0]
    stts = [struct.unpack_from(">II", buf, p + 8 + 8 * i) for i in range(n_stts)]

    def duration_iter() -> Iterator[int]:
        for cnt, dur in stts:
            for _ in range(cnt):
                yield int(dur)
        last = int(stts[-1][1]) if stts else 0
        while True:
            yield last

    durations = duration_iter()

    si = 0
    for ci, coff in enumerate(chunk_offsets):
        pos = int(coff)
        for _ in range(samples_in_chunk(ci)):
            if si >= count:
                return
            size = sample_size(si)
            yield pos, size, next(durations)
            pos += size
            si += 1


# ---------------------------------------------------------------------------
# 汎用 protobuf デコーダ（.proto スキーマ不要）
# ---------------------------------------------------------------------------
def read_varint(b: bytes, i: int) -> tuple[int, int]:
    shift = 0
    res = 0
    while True:
        x = b[i]
        i += 1
        res |= (x & 0x7F) << shift
        if not x & 0x80:
            break
        shift += 7
    return res, i


def pb_parse(b: bytes) -> dict[int, list[Any]]:
    """protobuf メッセージを {field: [values...]} に。値は wire-type ごとの生バイト/int。"""
    i = 0
    n = len(b)
    out: dict[int, list[Any]] = {}
    while i < n:
        try:
            key, i = read_varint(b, i)
            field = key >> 3
            wt = key & 7
            if wt == 0:
                v, i = read_varint(b, i)
            elif wt == 1:
                v = b[i:i + 8]
                i += 8
            elif wt == 5:
                v = b[i:i + 4]
                i += 4
            elif wt == 2:
                ln, i = read_varint(b, i)
                v = b[i:i + ln]
                i += ln
            else:
                break
        except IndexError:
            break
        out.setdefault(field, []).append(v)
    return out


def f32(b: bytes) -> float:
    return float(struct.unpack("<f", b)[0])


def f64(b: bytes) -> float:
    return float(struct.unpack("<d", b)[0])


def _sub(msg: dict[int, list[Any]], field: int) -> Optional[dict[int, list[Any]]]:
    """フィールドがあれば入れ子メッセージとして parse する。"""
    v = msg.get(field)
    if not v or not isinstance(v[0], (bytes, bytearray)):
        return None
    return pb_parse(bytes(v[0]))


# ---------------------------------------------------------------------------
# dvtm_ac206 (Osmo Action 6) フレームテレメトリの意味づけ
#
# 実データから確認できた構造::
#   top #1            : ヘッダ（先頭サンプルのみ）。proto名・機種・シリアル・FW
#   top #2            : ヘッダ（先頭サンプルのみ）。解像度・fps
#   top #3 #1 #1      : フレーム番号（0 は protobuf の既定値として省略される）
#   top #3 #1 #2      : 撮影タイムスタンプ [マイクロ秒]（カメラ内部時計）
#   top #3 #2         : ブロックA = カメラ/IMU
#       #3 #1 (f32)   : ISO
#       #6 #1 (varint): シャッター関連の生値（意味未確定）
#       #9            : 姿勢クォータニオン (w, x, y, z)
#       #10           : 3軸ベクトル（角速度 or 加速度と推定）
#   top #3 #4         : ブロックB = GPS / 日時 / 高度
#       #2 #1 #2/#3   : lat / lon (f64, WGS84)
#       #2 #2 (varint): 高度 [mm]（GSI DEM 192.9m に対し 199.69m。妥当な範囲で一致）
#       #2 #6 #1      : GPS 由来の日時文字列（※測位が切れると更新されない）
#       #3 #1/#2 (f32): GPS 精度と推定される 2 値（水平[m] / 垂直[m]）
# ---------------------------------------------------------------------------
def decode_header(sample_bytes: bytes) -> dict[str, Any]:
    """先頭サンプルから機種・FW・解像度などのヘッダ情報を取り出す。"""
    info: dict[str, Any] = {}
    top = pb_parse(sample_bytes)
    dev = _sub(top, 1)
    if dev:
        d1 = _sub(dev, 1)
        if d1:
            def s(field: int) -> Optional[str]:
                v = d1.get(field)
                if v and isinstance(v[0], (bytes, bytearray)):
                    return bytes(v[0]).decode("latin1", "replace")
                return None
            info["proto"] = s(1)
            info["proto_version"] = s(3)
            info["serial"] = s(5)
            info["firmware"] = s(6)
            info["model"] = s(10)
    vid = _sub(top, 2)
    if vid:
        v3 = _sub(vid, 3)
        if v3:
            if 1 in v3 and isinstance(v3[1][0], int):
                info["width"] = int(v3[1][0])
            if 2 in v3 and isinstance(v3[2][0], int):
                info["height"] = int(v3[2][0])
            if 3 in v3 and isinstance(v3[3][0], (bytes, bytearray)):
                info["fps"] = round(f32(bytes(v3[3][0])), 3)
    return info


def decode_frame(sample_bytes: bytes) -> dict[str, Any]:
    """1サンプル(protobuf)からテレメトリ dict を抽出。未知フィールドは黙って無視。"""
    rec: dict[str, Any] = {}
    top = pb_parse(sample_bytes)
    m3 = _sub(top, 3)
    if m3 is None:
        return rec  # メタデータ(先頭)サンプルなど

    # --- フレーム番号 / 撮影タイムスタンプ ---
    finfo = _sub(m3, 1)
    if finfo:
        rec["frame_index"] = int(finfo[1][0]) if 1 in finfo else 0
        if 2 in finfo and isinstance(finfo[2][0], int):
            rec["capture_us"] = int(finfo[2][0])

    # --- ブロックA (#2): 姿勢/IMU/露出 ---
    blk_a = _sub(m3, 2)
    if blk_a:
        iso = _sub(blk_a, 3)
        if iso and 1 in iso and isinstance(iso[1][0], (bytes, bytearray)):
            rec["iso"] = round(f32(bytes(iso[1][0])), 3)
        sh = _sub(blk_a, 6)
        if sh and 1 in sh and isinstance(sh[1][0], int):
            rec["shutter_raw"] = int(sh[1][0])
        q = _sub(blk_a, 9)
        if q:
            for name, fid in (("quat_w", 1), ("quat_x", 2), ("quat_y", 3), ("quat_z", 4)):
                if fid in q:
                    rec[name] = f32(bytes(q[fid][0]))
        v = _sub(blk_a, 10)
        if v:
            for name, fid in (("vec_x", 2), ("vec_y", 3), ("vec_z", 4)):
                if fid in v:
                    rec[name] = f32(bytes(v[fid][0]))

    # --- ブロックB (#4): GPS / 日時 / 高度 ---
    blk_b = _sub(m3, 4)
    if blk_b:
        b2 = _sub(blk_b, 2)
        if b2:
            gps = _sub(b2, 1)
            if gps:
                if 2 in gps:
                    rec["lat"] = f64(bytes(gps[2][0]))
                if 3 in gps:
                    rec["lon"] = f64(bytes(gps[3][0]))
            if 2 in b2 and isinstance(b2[2][0], int):
                rec["altitude_m"] = round(int(b2[2][0]) / 1000.0, 3)
            dt = _sub(b2, 6)
            if dt and 1 in dt and isinstance(dt[1][0], (bytes, bytearray)):
                rec["datetime_gps"] = bytes(dt[1][0]).decode("latin1", "replace")
        b3 = _sub(blk_b, 3)
        if b3:
            if 1 in b3 and isinstance(b3[1][0], (bytes, bytearray)):
                rec["gps_acc_h_m"] = round(f32(bytes(b3[1][0])), 3)
            if 2 in b3 and isinstance(b3[2][0], (bytes, bytearray)):
                rec["gps_acc_v_m"] = round(f32(bytes(b3[2][0])), 3)
    return rec


# ---------------------------------------------------------------------------
# 抽出本体
# ---------------------------------------------------------------------------
class TelemetryError(RuntimeError):
    """テレメトリトラックが見つからない等の致命的エラー。"""


def open_telemetry(path: str | Path) -> tuple[dict[str, Any], Iterator[dict[str, Any]]]:
    """(ヘッダ情報, テレメトリのジェネレータ) を返す。ファイルは mmap で開く。

    ジェネレータを最後まで回す（または close する）と mmap も閉じる。
    """
    fp: BinaryIO = open(path, "rb")
    mm = mmap.mmap(fp.fileno(), 0, access=mmap.ACCESS_READ)

    try:
        traks = find_metadata_traks(mm)
        meta = next((t for t in traks if t["codec"] == "djmd"), None)
        if meta is None:
            found = ", ".join(f"{t['handler']}/{t['codec']}" for t in traks)
            raise TelemetryError(
                f"djmd (DJI metadata) トラックが見つかりません。検出トラック: {found}"
            )

        timescale = meta["timescale"] or 30000
        header: dict[str, Any] = {
            "handler": meta["handler"],
            "codec": meta["codec"],
            "timescale": timescale,
        }
        # 先頭サンプルからヘッダ情報を取る
        for off, size, _dur in iter_sample_table(mm, meta["stbl_payload"], meta["stbl_end"]):
            header.update(decode_header(bytes(mm[off:off + size])))
            break
    except BaseException:
        mm.close()
        fp.close()
        raise

    def gen() -> Iterator[dict[str, Any]]:
        try:
            t_ticks = 0
            for off, size, dur in iter_sample_table(
                    mm, meta["stbl_payload"], meta["stbl_end"]):
                rec = decode_frame(bytes(mm[off:off + size]))
                rec["time_s"] = round(t_ticks / timescale, 4)
                t_ticks += dur
                if len(rec) > 1:  # time_s 以外に中身がある行のみ
                    yield rec
        finally:
            mm.close()
            fp.close()

    return header, gen()


def extract(path: str | Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """全サンプルをリストで返す（テスト・短い動画向け。長尺では open_telemetry を使う）。"""
    header, gen = open_telemetry(path)
    return list(gen), header


# ---------------------------------------------------------------------------
# サマリ（タイムラプス判定・GPS 健全性チェック）
# ---------------------------------------------------------------------------
#: distinct 値の収集上限（長尺でメモリが際限なく増えないようにする）
DISTINCT_LIMIT = 200_000


class SummaryCollector:
    """逐次処理しながら動画全体の統計を貯める。"""

    def __init__(self) -> None:
        self.count = 0
        self.first: Optional[dict[str, Any]] = None
        self.last: Optional[dict[str, Any]] = None
        self.gps_count = 0
        self.distinct_gps: set[tuple[float, float]] = set()
        self.distinct_datetime: set[str] = set()
        self.acc_h: list[float] = []

    def add(self, rec: dict[str, Any]) -> None:
        self.count += 1
        if self.first is None:
            self.first = rec
        self.last = rec
        if "lat" in rec and "lon" in rec:
            self.gps_count += 1
            if len(self.distinct_gps) < DISTINCT_LIMIT:
                self.distinct_gps.add((rec["lat"], rec["lon"]))
        if "datetime_gps" in rec and len(self.distinct_datetime) < DISTINCT_LIMIT:
            self.distinct_datetime.add(rec["datetime_gps"])
        if "gps_acc_h_m" in rec and len(self.acc_h) < DISTINCT_LIMIT:
            self.acc_h.append(rec["gps_acc_h_m"])

    def build(self, header: dict[str, Any]) -> dict[str, Any]:
        s: dict[str, Any] = {"header": header, "sample_count": self.count}
        if self.first is None or self.last is None:
            return s
        video_span = float(self.last.get("time_s", 0)) - float(self.first.get("time_s", 0))
        s["video_duration_s"] = round(video_span, 3)
        s["time_s_range"] = [self.first.get("time_s"), self.last.get("time_s")]

        # 撮影タイムスタンプ(µs)から実時間を求め、タイムラプス倍率を算出する
        if "capture_us" in self.first and "capture_us" in self.last:
            real_span = (self.last["capture_us"] - self.first["capture_us"]) / 1e6
            s["real_duration_s"] = round(real_span, 3)
            if video_span > 0:
                factor = real_span / video_span
                s["speed_factor"] = round(factor, 4)
                s["is_timelapse"] = bool(factor > 1.5)

        s["gps_sample_count"] = self.gps_count
        s["distinct_gps_fix_count"] = len(self.distinct_gps)
        s["distinct_datetime_count"] = len(self.distinct_datetime)
        if self.acc_h:
            s["gps_acc_h_m_median"] = round(sorted(self.acc_h)[len(self.acc_h) // 2], 3)
        if "datetime_gps" in self.first:
            s["datetime_gps_range"] = [self.first.get("datetime_gps"),
                                       self.last.get("datetime_gps")]
        s["gps_frozen"] = bool(self.gps_count > 1 and len(self.distinct_gps) <= 1)
        return s


def warn_on_summary(summary: dict[str, Any]) -> list[str]:
    """出題データとして使えるかどうかの警告文リストを返す。"""
    warns: list[str] = []
    if summary.get("gps_sample_count", 0) == 0:
        warns.append("GPS 座標が 1 件も含まれていません。GPX 側との時刻照合が必須です。")
    elif summary.get("gps_frozen"):
        warns.append(
            "GPS 座標が全フレームで同一です（測位が更新されていない）。"
            "この動画のテレメトリ GPS は位置の根拠に使えません。"
            "GPX と撮影時刻で照合してください。"
        )
    if summary.get("is_timelapse"):
        warns.append(
            f"タイムラプスと判定しました（実時間 / 動画時間 = "
            f"{summary.get('speed_factor')} 倍）。frame_time_s から実時刻への換算に注意。"
        )
    if summary.get("distinct_datetime_count", 0) <= 1 and summary.get("sample_count", 0) > 100:
        warns.append("GPS 日時が更新されていません（測位ロスト、または記録開始時の値の固定）。")
    return warns


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
#: DJI のファイル名 `DJI_YYYYMMDDHHMMSS_NNNN_X.MP4` から撮影開始時刻を読む
_DJI_NAME_RE = re.compile(r"DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_")


def start_time_from_filename(path: str | Path) -> Optional[str]:
    """DJI のファイル名から撮影開始のローカル日時（ISO8601, タイムゾーン無し）を返す。

    カメラのGPS日時は測位が切れると更新されないため、ファイル名の方が信用できる。
    """
    m = _DJI_NAME_RE.search(Path(path).name)
    if not m:
        return None
    y, mo, d, h, mi, s = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}"


def run(video: str, out_csv: Optional[str] = None, out_json: Optional[str] = None,
        out_summary: Optional[str] = None, progress_every: int = 20000,
        quiet: bool = False) -> dict[str, Any]:
    """抽出して CSV / JSON / サマリを書き出し、サマリ dict を返す。"""
    header, gen = open_telemetry(video)
    csv_path = Path(out_csv or (str(Path(video).with_suffix("")) + ".telemetry.csv"))
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    collector = SummaryCollector()
    json_fp = None
    if out_json:
        jp = Path(out_json)
        jp.parent.mkdir(parents=True, exist_ok=True)
        json_fp = jp.open("w", encoding="utf-8")
        json_fp.write("[\n")

    first_json = True
    with csv_path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for rec in gen:
            writer.writerow({c: rec.get(c, "") for c in COLUMNS})
            if json_fp is not None:
                if not first_json:
                    json_fp.write(",\n")
                first_json = False
                json_fp.write("  " + json.dumps(rec, ensure_ascii=False))
            collector.add(rec)
            if progress_every and not quiet and collector.count % progress_every == 0:
                print(f"  ... {collector.count} サンプル処理", file=sys.stderr)
    if json_fp is not None:
        json_fp.write("\n]\n")
        json_fp.close()

    summary = collector.build(header)
    summary["source"] = {
        "path": str(video),
        "filename": Path(video).name,
        # ファイル名由来の撮影開始ローカル日時（match_gpx.py の時刻照合の基準）
        "start_local": start_time_from_filename(video),
    }
    if out_summary:
        sp = Path(out_summary)
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    if not quiet:
        print(f"検出: model={header.get('model')} proto={header.get('proto')} "
              f"{header.get('width')}x{header.get('height')}@{header.get('fps')}fps "
              f"サンプル数={summary['sample_count']}")
        print(f"CSV 書き出し: {csv_path}")
        if out_json:
            print(f"JSON 書き出し: {out_json}")
        if out_summary:
            print(f"サマリ書き出し: {out_summary}")
        if "speed_factor" in summary:
            print(f"動画時間 {summary.get('video_duration_s')}s / 実時間 "
                  f"{summary.get('real_duration_s')}s → 倍率 {summary['speed_factor']}")
        for w in warn_on_summary(summary):
            print(f"警告: {w}", file=sys.stderr)
    return summary


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="DJI 動画テレメトリ抽出")
    ap.add_argument("video", help="DJI の .MP4 ファイル")
    ap.add_argument("-o", "--out", help="出力CSVパス（省略時は <video>.telemetry.csv）")
    ap.add_argument("--json", help="JSON でも出力する場合のパス")
    ap.add_argument("--summary", help="サマリJSONの出力パス")
    args = ap.parse_args(list(argv) if argv is not None else None)
    try:
        run(args.video, args.out, args.json, args.summary)
    except TelemetryError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
