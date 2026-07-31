"""公開データ生成（build_quiz_data.py）のテスト。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

import build_quiz_data as bq
from route_builder import build_route, write_gpx

MOUNTAIN = {"id": "odaigahara-2026-06-11", "name": "大台ヶ原・日出ヶ岳"}


def _confirmed(tmp_path: Path, points: list[dict[str, Any]],
               mountain: dict[str, Any] | None = None) -> Path:
    path = tmp_path / "confirmed_points.json"
    path.write_text(json.dumps({"mountain": mountain or MOUNTAIN, "points": points},
                               ensure_ascii=False), encoding="utf-8")
    return path


def _image(dir_: Path, point_id: str, index: int = 1) -> Path:
    dir_.mkdir(parents=True, exist_ok=True)
    p = dir_ / f"{point_id}-{index}.webp"
    p.write_bytes(b"RIFF____WEBPVP8 fake")
    return p


def _assigned(count: int = 1) -> list[dict[str, Any]]:
    """レビューで割り当てた画像（confirmed_points.json の images）。"""
    return [{"id": f"clip-{i:05d}", "kind": "video_frame", "media_id": "clip",
             "time_s": float(i)} for i in range(count)]


def _point(idx: int, **kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": f"{MOUNTAIN['id']}-{idx:03d}",
        "lat": 34.185 + idx * 0.001,
        "lon": 136.109 + idx * 0.001,
        "type": "peak",
        "source": "auto",
    }
    base.update(kw)
    return base


# ---------------------------------------------------------------------------
# dataset_version / max_distance_m
# ---------------------------------------------------------------------------
def test_dataset_version_is_utc_iso() -> None:
    v = bq.dataset_version(datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc))
    assert v == "2026-07-29T12:00:00Z"


def test_max_distance_is_half_the_bbox_diagonal(tmp_path: Path) -> None:
    route = build_route(start_lat=34.185, start_lon=136.109,
                        legs=((0.0, 800.0), (90.0, 600.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route)
    d = bq.max_distance_from_gpx(gpx, factor=0.5)
    # bbox は 800m × 600m → 対角 1000m → ×0.5 = 500m
    assert d == pytest.approx(500.0, rel=0.02)


def test_max_distance_factor_is_adjustable(tmp_path: Path) -> None:
    route = build_route(start_lat=34.185, start_lon=136.109,
                        legs=((0.0, 800.0), (90.0, 600.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route)
    assert bq.max_distance_from_gpx(gpx, 1.0) == pytest.approx(
        bq.max_distance_from_gpx(gpx, 0.5) * 2, rel=0.01)


def test_max_distance_has_a_floor(tmp_path: Path) -> None:
    route = build_route(legs=((0.0, 50.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "tiny.gpx", route)
    assert bq.max_distance_from_gpx(gpx) == bq.MIN_MAX_DISTANCE_M


def test_max_distance_falls_back_to_point_spread() -> None:
    pts = [{"lat": 34.180, "lon": 136.090}, {"lat": 34.188, "lon": 136.115}]
    assert bq.max_distance_from_points(pts, 0.5) > bq.MIN_MAX_DISTANCE_M
    with pytest.raises(bq.BuildError):
        bq.max_distance_from_points([])


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------
def test_quiz_points_matches_the_schema(tmp_path: Path) -> None:
    images = tmp_path / "frames"
    _image(images, f"{MOUNTAIN['id']}-001")
    confirmed = _confirmed(tmp_path, [
        _point(1, images=_assigned(1), heading_deg=128.4),
        _point(2, type="col", source="manual"),        # 3D専用（画像なし）
    ])
    meta = bq.run(str(confirmed), images_dir=str(images),
                  public_dir=str(tmp_path / "public"), quiet=True)

    data = json.loads(Path(meta["out"]).read_text(encoding="utf-8"))
    assert set(data) == {"dataset_version", "mountains", "points"}
    assert data["dataset_version"] == meta["dataset_version"]

    m = data["mountains"][0]
    assert set(m) == {"id", "name", "max_distance_m", "scoring_k"}
    assert m["scoring_k"] == 4.0

    p1, p2 = data["points"]
    assert p1["image_paths"] == [f"images/{MOUNTAIN['id']}/{MOUNTAIN['id']}-001-1.webp"]
    assert p1["heading_deg"] == 128.4
    assert "image_paths" not in p2      # 画像なし地点はモード②専用
    assert meta["with_image"] == 1
    assert meta["terrain_only"] == 1


def test_multiple_images_per_point(tmp_path: Path) -> None:
    """1地点に複数の画像を割り当てられる。"""
    images = tmp_path / "frames"
    for i in (1, 2, 3):
        _image(images, f"{MOUNTAIN['id']}-001", i)
    confirmed = _confirmed(tmp_path, [_point(1, images=_assigned(3))])
    meta = bq.run(str(confirmed), images_dir=str(images),
                  public_dir=str(tmp_path / "public"), quiet=True)
    point = json.loads(Path(meta["out"]).read_text(encoding="utf-8"))["points"][0]
    assert len(point["image_paths"]) == 3
    assert point["image_paths"][2].endswith("-3.webp")


def test_images_are_copied_into_public(tmp_path: Path) -> None:
    images = tmp_path / "frames"
    _image(images, f"{MOUNTAIN['id']}-001")
    confirmed = _confirmed(tmp_path, [_point(1, images=_assigned(1))])
    public = tmp_path / "public"
    bq.run(str(confirmed), images_dir=str(images), public_dir=str(public), quiet=True)
    assert (public / "images" / MOUNTAIN["id"] /
            f"{MOUNTAIN['id']}-001-1.webp").exists()


def test_intermediate_fields_are_not_published(tmp_path: Path) -> None:
    """生GPS・スナップ距離・品質スコアを公開JSONに出さない（docs/data-model.md）。"""
    images = tmp_path / "frames"
    _image(images, f"{MOUNTAIN['id']}-001")
    confirmed = _confirmed(tmp_path, [
        _point(1, images=_assigned(1),
               raw_lat=34.0, raw_lon=135.0,
               snap_distance_m=31900.0, blur_score=2100.0, low_quality=False,
               aux1=4.6, candidate_id="cand-0007"),
    ])
    meta = bq.run(str(confirmed), images_dir=str(images),
                  public_dir=str(tmp_path / "public"), quiet=True)
    raw = Path(meta["out"]).read_text(encoding="utf-8")
    # 出所（動画名・切り出し時刻）も公開しない。答えの手がかりになりうる
    for banned in ("raw_lat", "raw_lon", "snap_distance_m", "blur_score",
                   "low_quality", "aux1", "candidate_id", "media_id",
                   "frame_time_s", '"images"'):
        assert banned not in raw


def test_missing_image_is_a_hard_error(tmp_path: Path) -> None:
    confirmed = _confirmed(tmp_path, [
        _point(1, images=_assigned(1)),
        _point(2, images=_assigned(1)),
    ])
    with pytest.raises(bq.BuildError) as e:
        bq.run(str(confirmed), images_dir=str(tmp_path / "frames"),
               public_dir=str(tmp_path / "public"), quiet=True)
    assert f"{MOUNTAIN['id']}-001-1.webp" in str(e.value)
    assert f"{MOUNTAIN['id']}-002-1.webp" in str(e.value)


def test_gpx_determines_max_distance(tmp_path: Path) -> None:
    route = build_route(start_lat=34.185, start_lon=136.109,
                        legs=((0.0, 800.0), (90.0, 600.0)), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route)
    confirmed = _confirmed(tmp_path, [_point(1)])
    meta = bq.run(str(confirmed), gpx=str(gpx),
                  public_dir=str(tmp_path / "public"), quiet=True)
    assert meta["mountain"]["max_distance_m"] == pytest.approx(500.0, rel=0.02)


def test_gpx_of_another_mountain_is_rejected(tmp_path: Path) -> None:
    """別の山のGPXを選んだまま実行したら止める（地点は正しく線だけ他の山、を防ぐ）。"""
    # 地点は 34.18/136.10 付近、GPXは遠く離れた場所
    far = build_route(start_lat=35.37, start_lon=134.53,
                      legs=((0.0, 500.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "other.gpx", far)
    confirmed = _confirmed(tmp_path, [_point(1), _point(2)])
    with pytest.raises(bq.BuildError, match="GPX"):
        bq.run(str(confirmed), gpx=str(gpx),
               public_dir=str(tmp_path / "public"), quiet=True)


def test_matching_gpx_records_how_close_the_points_are(tmp_path: Path) -> None:
    route = build_route(start_lat=34.185, start_lon=136.109,
                        legs=((45.0, 600.0),), step_m=10.0)
    gpx = write_gpx(tmp_path / "r.gpx", route)
    confirmed = _confirmed(tmp_path, [_point(1), _point(2)])
    meta = bq.run(str(confirmed), gpx=str(gpx),
                  public_dir=str(tmp_path / "public"), quiet=True)
    assert meta["track"]["match_offset_m"] < bq.TRACK_MATCH_MAX_M


# ---------------------------------------------------------------------------
# マージ
# ---------------------------------------------------------------------------
def test_adding_a_second_mountain_keeps_the_first(tmp_path: Path) -> None:
    public = tmp_path / "public"
    first = _confirmed(tmp_path, [_point(1)])
    bq.run(str(first), public_dir=str(public), quiet=True,
           now=datetime(2026, 7, 29, 10, 0, tzinfo=timezone.utc))

    other = {"id": "kongo-2026-08-01", "name": "金剛山"}
    second_points = [{"id": "kongo-2026-08-01-001", "lat": 34.41, "lon": 135.67,
                      "type": "peak", "source": "auto"}]
    second = tmp_path / "confirmed2.json"
    second.write_text(json.dumps({"mountain": other, "points": second_points},
                                 ensure_ascii=False), encoding="utf-8")
    meta = bq.run(str(second), public_dir=str(public), quiet=True,
                  now=datetime(2026, 7, 29, 11, 0, tzinfo=timezone.utc))

    data = json.loads(Path(meta["out"]).read_text(encoding="utf-8"))
    assert [m["id"] for m in data["mountains"]] == ["kongo-2026-08-01", MOUNTAIN["id"]]
    assert len(data["points"]) == 2
    assert data["dataset_version"] == "2026-07-29T11:00:00Z"   # 更新される


def test_rerunning_the_same_mountain_replaces_its_points(tmp_path: Path) -> None:
    public = tmp_path / "public"
    bq.run(str(_confirmed(tmp_path, [_point(1), _point(2)])),
           public_dir=str(public), quiet=True)
    meta = bq.run(str(_confirmed(tmp_path, [_point(1)])),
                  public_dir=str(public), quiet=True)
    data = json.loads(Path(meta["out"]).read_text(encoding="utf-8"))
    assert len(data["points"]) == 1                       # 重複しない
    assert len(data["mountains"]) == 1


# ---------------------------------------------------------------------------
# 入力の検証
# ---------------------------------------------------------------------------
def test_missing_mountain_info_is_an_error(tmp_path: Path) -> None:
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"points": [_point(1)]}), encoding="utf-8")
    with pytest.raises(bq.BuildError):
        bq.load_confirmed(path)


def test_duplicate_point_ids_are_rejected(tmp_path: Path) -> None:
    confirmed = _confirmed(tmp_path, [_point(1), _point(1)])
    with pytest.raises(bq.BuildError):
        bq.load_confirmed(confirmed)


def test_empty_points_are_rejected(tmp_path: Path) -> None:
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"mountain": MOUNTAIN, "points": []}), encoding="utf-8")
    with pytest.raises(bq.BuildError):
        bq.load_confirmed(path)


def test_cli(tmp_path: Path) -> None:
    confirmed = _confirmed(tmp_path, [_point(1)])
    code = bq.main(["--confirmed", str(confirmed),
                    "--public-dir", str(tmp_path / "public")])
    assert code == 0
    assert (tmp_path / "public" / "data" / "quiz_points.json").exists()


def test_cli_reports_error(tmp_path: Path) -> None:
    assert bq.main(["--confirmed", str(tmp_path / "nope.json")]) == 1
