"""機能A（テレメトリ抽出）の受け入れ条件に対応するテスト。

- 実動画から切り出した fixture（djmd のみの小さな MP4）での回帰テスト
- 実機では再現しづらい条件（タイムラプス・GPS 欠落・co64・複数チャンク）は
  protobuf/MP4 を合成して検証する
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

import extract_telemetry as et
from dji_pb import make_header_sample, make_sample
from mp4_builder import build_djmd_mp4

FIXTURE = Path(__file__).parent / "fixtures" / "sample_djmd.mp4"


# ---------------------------------------------------------------------------
# 実動画由来 fixture
# ---------------------------------------------------------------------------
def test_fixture_parses_all_samples() -> None:
    rows, header = et.extract(FIXTURE)
    assert len(rows) == 120
    assert header["model"] == "DJI OsmoAction6"
    assert header["proto"] == "dvtm_ac206.proto"
    assert (header["width"], header["height"]) == (3840, 2160)
    assert header["fps"] == pytest.approx(29.97, abs=0.01)


def test_fixture_fields_are_decoded() -> None:
    rows, _ = et.extract(FIXTURE)
    first = rows[0]
    # fixture のGPS座標は make_fixture.py がダミー値に洗ってある
    # （公開リポジトリに撮影者の測位地点を残さないため）
    assert first["lat"] == pytest.approx(34.0, abs=1e-7)
    assert first["lon"] == pytest.approx(135.0, abs=1e-7)
    # 高度[mm] → m。実測時、元の座標での国土地理院DEM(192.9m)と数m差で一致した
    assert first["altitude_m"] == pytest.approx(199.69, abs=0.01)
    assert first["gps_acc_h_m"] == pytest.approx(4.6, abs=0.01)
    assert first["gps_acc_v_m"] == pytest.approx(12.1, abs=0.01)
    assert first["datetime_gps"] == "2026-07-11 07:28:33"
    # クォータニオンは正規化されている
    norm = sum(first[k] ** 2 for k in ("quat_w", "quat_x", "quat_y", "quat_z")) ** 0.5
    assert norm == pytest.approx(1.0, abs=1e-3)


def test_fixture_time_and_frame_index_are_monotonic() -> None:
    rows, _ = et.extract(FIXTURE)
    times = [r["time_s"] for r in rows]
    caps = [r["capture_us"] for r in rows]
    idxs = [r["frame_index"] for r in rows]
    assert times == sorted(times)
    assert caps == sorted(caps)
    assert idxs == list(range(len(rows)))
    # capture_us の刻みは 1/29.97 秒に一致する
    step_us = (caps[-1] - caps[0]) / (len(caps) - 1)
    assert step_us == pytest.approx(1e6 / 29.97, rel=0.01)


def test_fixture_summary_flags_frozen_gps() -> None:
    rows, header = et.extract(FIXTURE)
    col = et.SummaryCollector()
    for r in rows:
        col.add(r)
    summary = col.build(header)
    assert summary["speed_factor"] == pytest.approx(1.0, abs=0.01)
    assert summary["is_timelapse"] is False
    assert summary["distinct_gps_fix_count"] == 1
    assert summary["gps_frozen"] is True
    assert any("同一" in w for w in et.warn_on_summary(summary))


# ---------------------------------------------------------------------------
# 合成データ：タイムラプス／GPS 欠落／長尺
# ---------------------------------------------------------------------------
def _synth_mp4(n: int, interval_us: int, with_gps: bool = True,
               moving: bool = True, **kw: object) -> bytes:
    """n フレーム、実時間 interval_us 刻みの合成 MP4 を作る。"""
    samples = []
    for i in range(n):
        lat = 34.40 + (0.0001 * i if moving else 0.0)
        lon = 135.87 + (0.0001 * i if moving else 0.0)
        s = make_sample(
            frame_index=i,
            capture_us=1_000_000 + i * interval_us,
            lat=lat if with_gps else None,
            lon=lon if with_gps else None,
            altitude_mm=200_000 + i if with_gps else None,
            datetime_gps=f"2026-07-11 07:{i // 60:02d}:{i % 60:02d}" if with_gps else None,
            acc_h=4.6, acc_v=12.1,
        )
        if i == 0:
            s = make_header_sample() + s
        samples.append(s)
    return build_djmd_mp4(samples, **kw)  # type: ignore[arg-type]


def _summary_of(path: Path) -> dict:
    rows, header = et.extract(path)
    col = et.SummaryCollector()
    for r in rows:
        col.add(r)
    return col.build(header)


def test_timelapse_is_detected(tmp_path: Path) -> None:
    """実時間 2 秒 / 動画 1/29.97 秒 = 約60倍のタイムラプスを検出できる。"""
    p = tmp_path / "timelapse.mp4"
    p.write_bytes(_synth_mp4(300, interval_us=2_000_000))
    s = _summary_of(p)
    assert s["is_timelapse"] is True
    assert s["speed_factor"] == pytest.approx(2_000_000 / (1001 / 30000 * 1e6), rel=0.01)
    assert s["real_duration_s"] == pytest.approx(299 * 2.0, rel=0.001)
    assert any("タイムラプス" in w for w in et.warn_on_summary(s))


def test_normal_speed_is_not_timelapse(tmp_path: Path) -> None:
    p = tmp_path / "normal.mp4"
    p.write_bytes(_synth_mp4(120, interval_us=33_367))
    s = _summary_of(p)
    assert s["is_timelapse"] is False
    assert s["speed_factor"] == pytest.approx(1.0, abs=0.01)


def test_moving_gps_is_not_flagged_frozen(tmp_path: Path) -> None:
    p = tmp_path / "moving.mp4"
    p.write_bytes(_synth_mp4(120, interval_us=1_000_000, moving=True))
    s = _summary_of(p)
    assert s["distinct_gps_fix_count"] == 120
    assert s["gps_frozen"] is False
    assert not any("同一" in w for w in et.warn_on_summary(s))


def test_missing_gps_is_reported(tmp_path: Path) -> None:
    p = tmp_path / "nogps.mp4"
    p.write_bytes(_synth_mp4(60, interval_us=33_367, with_gps=False))
    s = _summary_of(p)
    assert s["gps_sample_count"] == 0
    assert any("GPS 座標が 1 件も含まれていません" in w for w in et.warn_on_summary(s))


# ---------------------------------------------------------------------------
# MP4 構造のバリエーション（長尺動画で実際に現れる形）
# ---------------------------------------------------------------------------
def test_co64_offsets_are_supported(tmp_path: Path) -> None:
    """4GB を超える動画では stco ではなく co64 が使われる。"""
    p = tmp_path / "co64.mp4"
    p.write_bytes(_synth_mp4(50, interval_us=1_000_000, use_co64=True))
    rows, _ = et.extract(p)
    assert len(rows) == 50
    assert rows[10]["lat"] == pytest.approx(34.40 + 0.001, abs=1e-9)


def test_multi_chunk_sample_table_is_supported(tmp_path: Path) -> None:
    """サンプルが複数チャンクに分かれていても順序どおり読める。"""
    p = tmp_path / "chunks.mp4"
    p.write_bytes(_synth_mp4(97, interval_us=1_000_000, samples_per_chunk=7))
    rows, _ = et.extract(p)
    assert [r["frame_index"] for r in rows] == list(range(97))


def test_missing_djmd_track_raises(tmp_path: Path) -> None:
    p = tmp_path / "other.mp4"
    p.write_bytes(build_djmd_mp4([make_sample(0, 0)], codec=b"mebx",
                                 handler_name="Other meta"))
    with pytest.raises(et.TelemetryError):
        et.extract(p)


# ---------------------------------------------------------------------------
# CLI（run）の出力
# ---------------------------------------------------------------------------
def test_run_writes_csv_json_and_summary(tmp_path: Path) -> None:
    out_csv = tmp_path / "t.csv"
    out_json = tmp_path / "t.json"
    out_sum = tmp_path / "s.json"
    summary = et.run(str(FIXTURE), str(out_csv), str(out_json), str(out_sum), quiet=True)

    with out_csv.open(encoding="utf-8") as fp:
        rows = list(csv.DictReader(fp))
    assert len(rows) == 120
    assert list(rows[0].keys()) == et.COLUMNS

    data = json.loads(out_json.read_text(encoding="utf-8"))
    assert len(data) == 120
    assert data[0]["lat"] == pytest.approx(34.0, abs=1e-7)

    assert json.loads(out_sum.read_text(encoding="utf-8")) == summary


def test_run_streams_without_loading_all_rows(tmp_path: Path) -> None:
    """長尺想定：3万フレームでも全行をメモリに溜めずに書き出せる。"""
    p = tmp_path / "long.mp4"
    p.write_bytes(_synth_mp4(30_000, interval_us=1_000_000))
    summary = et.run(str(p), str(tmp_path / "long.csv"), None,
                     str(tmp_path / "long_summary.json"), quiet=True)
    assert summary["sample_count"] == 30_000
    assert summary["is_timelapse"] is True
