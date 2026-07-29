"""ローカル管理UI（studio.py）と候補の一括採用（adopt_candidates.py）のテスト。

studio.py は外に出さないツールなので、コマンド組み立てとローカル限定の
振る舞いだけを押さえる。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import adopt_candidates as ac
import studio


def _candidates(tmp_path: Path, items: list[dict[str, Any]]) -> Path:
    path = tmp_path / "candidates.json"
    path.write_text(json.dumps({"meta": {}, "candidates": items}, ensure_ascii=False),
                    encoding="utf-8")
    return path


def _cand(i: int, **kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": f"cand-{i:04d}",
        "type": "peak",
        "lat": 34.18 + i * 0.001,
        "lon": 136.10 + i * 0.001,
        "route_distance_m": i * 100.0,
        "score": 0.5,
        "elevation_m": 1500.0 + i,
    }
    base.update(kw)
    return base


# ---------------------------------------------------------------------------
# adopt_candidates
# ---------------------------------------------------------------------------
def test_adopt_assigns_sequential_ids_in_route_order(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [_cand(3), _cand(1), _cand(2)])
    result = ac.adopt(path, "odaigahara-2026-06-11", "大台ヶ原")
    assert [p["id"] for p in result["points"]] == [
        "odaigahara-2026-06-11-001",
        "odaigahara-2026-06-11-002",
        "odaigahara-2026-06-11-003",
    ]
    # 経路長の順に並ぶ
    assert result["points"][0]["candidate_id"] == "cand-0001"
    assert result["reviewed"] is False


def test_adopt_carries_elevation_and_frame_time(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [
        _cand(1, media_id="clip", frame_time_s=12.5, heading_route_deg=88.0),
    ])
    point = ac.adopt(path, "m", "山")["points"][0]
    assert point["elevation_m"] == 1501.0
    assert point["media_id"] == "clip"
    assert point["frame_time_s"] == 12.5
    assert point["heading_route_deg"] == 88.0


def test_adopt_skips_low_quality_by_default(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [_cand(1), _cand(2, low_quality=True)])
    assert len(ac.adopt(path, "m", "山")["points"]) == 1
    assert len(ac.adopt(path, "m", "山", skip_low_quality=False)["points"]) == 2


def test_adopt_filters_by_type_score_and_limit(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [
        _cand(1, type="peak", score=0.9),
        _cand(2, type="bend", score=0.9),
        _cand(3, type="peak", score=0.1),
    ])
    assert len(ac.adopt(path, "m", "山", types=["peak"])["points"]) == 2
    assert len(ac.adopt(path, "m", "山", min_score=0.5)["points"]) == 2
    assert len(ac.adopt(path, "m", "山", limit=1)["points"]) == 1


def test_adopt_rejects_empty_result(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [_cand(1, type="bend")])
    with pytest.raises(ac.AdoptError):
        ac.adopt(path, "m", "山", types=["peak"])
    with pytest.raises(ac.AdoptError):
        ac.adopt(_candidates(tmp_path, []), "m", "山")


def test_adopt_cli(tmp_path: Path) -> None:
    path = _candidates(tmp_path, [_cand(1), _cand(2)])
    out = tmp_path / "confirmed.json"
    code = ac.main(["--candidates", str(path), "--mountain-id", "m",
                    "--mountain-name", "山", "--out", str(out)])
    assert code == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["mountain"] == {"id": "m", "name": "山"}
    assert len(data["points"]) == 2


# ---------------------------------------------------------------------------
# studio のコマンド組み立て
# ---------------------------------------------------------------------------
def test_build_argv_telemetry() -> None:
    label, argv = studio.build_argv("telemetry", {"videos": ["Source/DJI_0001.MP4"]})
    assert "テレメトリ抽出" in label
    assert "pipeline/extract_telemetry.py" in argv
    assert "Source/DJI_0001.MP4" in argv
    assert "pipeline/data/DJI_0001.json" in argv


def test_build_argv_match_uses_each_video_telemetry() -> None:
    _label, argv = studio.build_argv("match", {
        "gpx": "Source/r.gpx",
        "videos": ["Source/a.MP4", "Source/b.MP4"],
        "time_offset_s": 12,
    })
    assert argv.count("--telemetry") == 2
    assert "pipeline/data/a.json" in argv
    assert "pipeline/data/b.json" in argv
    assert "--time-offset-s" in argv and "12" in argv


def test_build_argv_detect_prefers_track_then_gpx() -> None:
    _l, with_track = studio.build_argv("detect", {"use_track": True, "gpx": "Source/r.gpx"})
    assert "--track" in with_track and "--gpx" not in with_track

    _l2, gpx_only = studio.build_argv("detect", {"use_track": False, "gpx": "Source/r.gpx"})
    assert "--gpx" in gpx_only and "--track" not in gpx_only


def test_build_argv_video_mapping_uses_media_id() -> None:
    _l, argv = studio.build_argv("library", {"videos": ["Source/DJI_0007.MP4"]})
    assert "DJI_0007=Source/DJI_0007.MP4" in argv


def test_build_argv_requires_inputs() -> None:
    with pytest.raises(ValueError):
        studio.build_argv("telemetry", {"videos": []})
    with pytest.raises(ValueError):
        studio.build_argv("match", {"gpx": "", "videos": ["a.MP4"]})
    with pytest.raises(ValueError):
        studio.build_argv("detect", {"use_track": False, "gpx": ""})
    with pytest.raises(ValueError):
        studio.build_argv("adopt_all", {"mountain_id": "", "mountain_name": ""})
    with pytest.raises(ValueError):
        studio.build_argv("unknown-step", {})


def test_build_argv_adopt_all_passes_mountain() -> None:
    _l, argv = studio.build_argv("adopt_all", {
        "mountain_id": "odaigahara-2026-06-11", "mountain_name": "大台ヶ原",
    })
    assert "pipeline/adopt_candidates.py" in argv
    assert "odaigahara-2026-06-11" in argv
    assert "大台ヶ原" in argv


def test_build_argv_library_takes_videos_and_photos() -> None:
    """画像ライブラリは動画も写真もまとめて作る。GPXも山IDも要らない。"""
    _l, argv = studio.build_argv("library", {
        "videos": ["Source/a.MP4"], "interval_s": 3,
    })
    assert "pipeline/build_library.py" in argv
    assert "Source/photos" in argv
    assert "a=Source/a.MP4" in argv
    assert "--interval-s" in argv and "3" in argv

    # 動画が無くても（写真だけでも）作れる
    _l2, photos_only = studio.build_argv("library", {"videos": []})
    assert "pipeline/build_library.py" in photos_only


def test_list_state_shape() -> None:
    state = studio.list_state()
    assert set(state) >= {"videos", "gpx", "photos", "unsupported_photos",
                          "mountains", "intermediate", "source_dir_exists"}
    assert isinstance(state["videos"], list)
    assert isinstance(state["mountains"], list)
    assert isinstance(state["photos"], list)


# ---------------------------------------------------------------------------
# アップロード
# ---------------------------------------------------------------------------
def test_safe_filename_strips_paths() -> None:
    assert studio.safe_filename("../../etc/passwd") == "passwd"
    assert studio.safe_filename("C:\\Users\\me\\IMG_0001.JPG") == "IMG_0001.JPG"
    assert studio.safe_filename("") == "upload"
    # 日本語のファイル名はそのまま残す（スマホから来る名前を壊さない）
    assert studio.safe_filename("写真 (1).jpg") == "写真 (1).jpg"
    # 区切り文字や制御文字は落とす
    assert "/" not in studio.safe_filename("a/b.jpg")
    assert ":" not in studio.safe_filename("a:b.jpg")


def test_save_upload_rejects_unknown_kind_and_suffix(monkeypatch: pytest.MonkeyPatch,
                                                     tmp_path: Path) -> None:
    monkeypatch.setattr(studio, "UPLOAD_KINDS", {
        "photo": (tmp_path / "photos", {".jpg"}),
    })
    with pytest.raises(ValueError):
        studio.save_upload("script", "evil.py", b"x")
    with pytest.raises(ValueError):
        studio.save_upload("photo", "evil.exe", b"x")


def test_save_upload_writes_and_avoids_overwrite(monkeypatch: pytest.MonkeyPatch,
                                                 tmp_path: Path) -> None:
    photos = tmp_path / "photos"
    monkeypatch.setattr(studio, "UPLOAD_KINDS", {"photo": (photos, {".jpg"})})
    monkeypatch.setattr(studio, "ROOT", tmp_path)

    first = studio.save_upload("photo", "IMG_0001.jpg", b"aaa")
    second = studio.save_upload("photo", "IMG_0001.jpg", b"bbb")
    assert first["name"] == "IMG_0001.jpg"
    assert second["name"] == "IMG_0001-2.jpg"      # 上書きしない
    assert (photos / "IMG_0001.jpg").read_bytes() == b"aaa"
    assert (photos / "IMG_0001-2.jpg").read_bytes() == b"bbb"


def test_save_upload_cannot_escape_the_directory(monkeypatch: pytest.MonkeyPatch,
                                                 tmp_path: Path) -> None:
    photos = tmp_path / "photos"
    monkeypatch.setattr(studio, "UPLOAD_KINDS", {"photo": (photos, {".jpg"})})
    monkeypatch.setattr(studio, "ROOT", tmp_path)
    info = studio.save_upload("photo", "../../../evil.jpg", b"x")
    assert (photos / "evil.jpg").exists()
    assert ".." not in info["path"]


def test_all_steps_are_buildable_or_reject_cleanly() -> None:
    """UIが投げうる全工程が、成功するか ValueError で止まるかのどちらかになる。"""
    params = {
        "gpx": "Source/r.gpx",
        "videos": ["Source/a.MP4"],
        "mountain_id": "m",
        "mountain_name": "山",
        "use_track": True,
    }
    for step in studio.STEPS:
        label, argv = studio.build_argv(step, params)
        assert label
        assert argv[0] and argv[1].startswith("pipeline/")
