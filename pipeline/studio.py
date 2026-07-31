#!/usr/bin/env python3
"""出題データを追加するためのローカル専用UI（開発者向け）。

GPXと動画を選んで、テレメトリ抽出→GPX照合→候補検出→プレビュー→レビュー→
画像切り出し→quiz_points.json生成 を画面から順に実行する。

**ローカル専用。** 127.0.0.1 にだけ待ち受け、外部からは繋がらない。
GitHub Pages に配信されるのは `public/` だけなので、このツールは公開されない。

使い方::

    python pipeline/studio.py          # http://127.0.0.1:8770 を開く
    python pipeline/studio.py --port 9000
"""
from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
import os
import shlex
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
PIPELINE = ROOT / "pipeline"
SOURCE_DIR = ROOT / "Source"
PHOTOS_DIR = SOURCE_DIR / "photos"
DATA_DIR = PIPELINE / "data"
PUBLIC_DIR = ROOT / "public"

VIDEO_SUFFIXES = {".mp4", ".mov", ".MP4", ".MOV"}
GPX_SUFFIXES = {".gpx", ".GPX"}
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".JPG", ".JPEG", ".tif", ".tiff", ".TIF", ".TIFF"}
#: 読めないが、スマホからよく来る形式（案内を出すため受け取りはする）
PHOTO_UNSUPPORTED = {".heic", ".HEIC", ".heif", ".HEIF"}

#: アップロードを受け付ける種別と置き場
UPLOAD_KINDS: dict[str, tuple[Path, set[str]]] = {
    "gpx": (SOURCE_DIR, GPX_SUFFIXES),
    "video": (SOURCE_DIR, VIDEO_SUFFIXES),
    "photo": (PHOTOS_DIR, PHOTO_SUFFIXES | PHOTO_UNSUPPORTED),
}
#: 1ファイルの上限。長時間の動画も置けるように大きめ
MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024

#: 画面から実行できる工程。argv は studio.html 側の入力から組み立てる
STEPS = ("library", "detect", "frames", "build", "adopt_all", "telemetry", "match")

#: レビュー画面が保存する確定データの置き場
CONFIRMED_PATH = DATA_DIR / "confirmed_points.json"

#: レビュー画面（review.html）が使う地図ライブラリ。studio から配る
VENDOR_PREFIX = "node_modules/maplibre-gl/dist/"


class Job:
    """1回のコマンド実行。出力を貯めて画面から読み出せるようにする。"""

    _counter = 0
    _lock = threading.Lock()
    _jobs: dict[str, "Job"] = {}

    def __init__(self, label: str, argv: list[str]) -> None:
        with Job._lock:
            Job._counter += 1
            self.id = f"job-{Job._counter:04d}"
            Job._jobs[self.id] = self
        self.label = label
        self.argv = argv
        self.lines: list[str] = [f"$ {shlex.join(argv)}"]
        self.done = False
        self.returncode: Optional[int] = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    @classmethod
    def get(cls, job_id: str) -> Optional["Job"]:
        return cls._jobs.get(job_id)

    def start(self) -> "Job":
        self._thread.start()
        return self

    def _run(self) -> None:
        # 子プロセスにもUTF-8で喋らせる。Windowsの既定（cp932）のまま出させると、
        # こちらがUTF-8として読むので日本語のログが化ける（画面に「�」が並ぶ）。
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        try:
            proc = subprocess.Popen(
                self.argv, cwd=str(ROOT), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", bufsize=1, env=env,
            )
        except OSError as e:
            self.lines.append(f"起動できませんでした: {e}")
            self.returncode = -1
            self.done = True
            return
        assert proc.stdout is not None
        for line in proc.stdout:
            self.lines.append(line.rstrip("\n"))
        proc.wait()
        self.returncode = proc.returncode
        self.lines.append(
            "完了" if proc.returncode == 0 else f"失敗しました（終了コード {proc.returncode}）"
        )
        self.done = True

    def snapshot(self, offset: int) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "lines": self.lines[offset:],
            "next": len(self.lines),
            "done": self.done,
            "returncode": self.returncode,
        }


# ---------------------------------------------------------------------------
# 素材と現状の把握
# ---------------------------------------------------------------------------
def safe_filename(name: str) -> str:
    """アップロードされた名前から、置き場所を壊しうる文字を落とす。"""
    base = Path(name.replace("\\", "/")).name
    cleaned = "".join(c for c in base if c.isalnum() or c in "._- ()").strip()
    return cleaned or "upload"


def save_upload(kind: str, name: str, data: bytes) -> dict[str, Any]:
    """アップロードされたファイルを Source/ 配下に置く。"""
    if kind not in UPLOAD_KINDS:
        raise ValueError(f"受け付けない種別です: {kind}")
    directory, suffixes = UPLOAD_KINDS[kind]
    filename = safe_filename(name)
    if Path(filename).suffix not in suffixes:
        allowed = "・".join(sorted({s.lower() for s in suffixes}))
        raise ValueError(f"{filename} は扱えません（{allowed} のいずれか）")
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / filename
    # 同名があれば上書きせず連番を付ける（撮り直しを消さないため）
    if dest.exists():
        stem, suffix = dest.stem, dest.suffix
        i = 2
        while dest.exists():
            dest = directory / f"{stem}-{i}{suffix}"
            i += 1
    dest.write_bytes(data)
    return {"path": dest.relative_to(ROOT).as_posix(), "name": dest.name,
            "size_mb": round(len(data) / 1024 / 1024, 2)}


def save_confirmed(data: Any) -> dict[str, Any]:
    """レビュー画面から送られた確定地点を `pipeline/data/confirmed_points.json` に書く。

    **ダウンロードを挟まないためにある。** ブラウザに落として自分で置き直す作業は、
    画面だけで完結させるという studio の目的から外れる（置き場所を間違えれば
    次の工程が古いデータを読む）。
    """
    if not isinstance(data, dict):
        raise ValueError("確定データの形が違います")
    mountain = data.get("mountain")
    points = data.get("points")
    if not isinstance(mountain, dict) or not mountain.get("id") or not mountain.get("name"):
        raise ValueError("山IDと山名を入力してください")
    if not isinstance(points, list) or not points:
        raise ValueError("採用された地点がありません")
    for point in points:
        if not isinstance(point, dict) or "lat" not in point or "lon" not in point:
            raise ValueError("地点に緯度経度がありません")
    CONFIRMED_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIRMED_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    with_images = sum(1 for p in points if p.get("images"))
    return {
        "path": CONFIRMED_PATH.relative_to(ROOT).as_posix(),
        "point_count": len(points),
        "with_images": with_images,
    }


def list_state() -> dict[str, Any]:
    """Source/ の素材と、いま公開されている出題データの状況を返す。"""
    videos = []
    gpx_files = []
    photos = []
    unsupported_photos = []
    if SOURCE_DIR.exists():
        for path in sorted(SOURCE_DIR.iterdir()):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT).as_posix()
            info = {"path": rel, "name": path.name,
                    "size_mb": round(path.stat().st_size / 1024 / 1024, 1)}
            if path.suffix in VIDEO_SUFFIXES:
                info["media_id"] = path.stem
                videos.append(info)
            elif path.suffix in GPX_SUFFIXES:
                gpx_files.append(info)
    if PHOTOS_DIR.exists():
        for path in sorted(PHOTOS_DIR.iterdir()):
            if not path.is_file():
                continue
            if path.suffix in PHOTO_SUFFIXES:
                photos.append(path.name)
            elif path.suffix in PHOTO_UNSUPPORTED:
                unsupported_photos.append(path.name)

    mountains: list[dict[str, Any]] = []
    quiz_path = PUBLIC_DIR / "data" / "quiz_points.json"
    if quiz_path.exists():
        try:
            data = json.loads(quiz_path.read_text(encoding="utf-8"))
            counts: dict[str, int] = {}
            for p in data.get("points", []):
                counts[p["mountain_id"]] = counts.get(p["mountain_id"], 0) + 1
            for m in data.get("mountains", []):
                mountains.append({**m, "point_count": counts.get(m["id"], 0)})
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    def exists(rel: str) -> bool:
        return (ROOT / rel).exists()

    return {
        "videos": videos,
        "gpx": gpx_files,
        "photos": photos,
        "unsupported_photos": unsupported_photos,
        "mountains": mountains,
        "intermediate": {
            "library": exists("pipeline/data/library/index.json"),
            "track": exists("pipeline/data/track.json"),
            "candidates": exists("pipeline/data/candidates.json"),
            "confirmed": exists("pipeline/data/confirmed_points.json"),
            "frames": exists("pipeline/data/frames"),
        },
        "source_dir_exists": SOURCE_DIR.exists(),
    }


# ---------------------------------------------------------------------------
# 工程 → コマンド
# ---------------------------------------------------------------------------
def build_argv(step: str, params: dict[str, Any]) -> tuple[str, list[str]]:
    """工程名と画面からの入力から、実行するコマンドを組み立てる。"""
    py = sys.executable
    videos: list[str] = [v for v in params.get("videos", []) if v]
    gpx: str = params.get("gpx", "")
    mountain_id: str = (params.get("mountain_id") or "").strip()
    mountain_name: str = (params.get("mountain_name") or "").strip()

    if step == "telemetry":
        if not videos:
            raise ValueError("動画を1つ以上選んでください")
        video = videos[0]
        stem = Path(video).stem
        return (f"テレメトリ抽出: {Path(video).name}", [
            py, "pipeline/extract_telemetry.py", video,
            "-o", f"pipeline/data/{stem}.csv",
            "--json", f"pipeline/data/{stem}.json",
            "--summary", f"pipeline/data/{stem}_summary.json",
        ])

    if step == "match":
        if not gpx:
            raise ValueError("GPXを選んでください")
        argv = [py, "pipeline/match_gpx.py", "--gpx", gpx,
                "--out", "pipeline/data/track.json"]
        for video in videos:
            argv += ["--telemetry", f"pipeline/data/{Path(video).stem}.json"]
        if not videos:
            raise ValueError("先にテレメトリを抽出した動画を選んでください")
        if params.get("time_offset_s"):
            argv += ["--time-offset-s", str(params["time_offset_s"])]
        return ("GPX照合", argv)

    if step == "detect":
        argv = [py, "pipeline/detect_candidates.py",
                "--out", "pipeline/data/candidates.json"]
        if params.get("use_track"):
            argv += ["--track", "pipeline/data/track.json"]
        elif gpx:
            argv += ["--gpx", gpx]
        else:
            raise ValueError("GPXを選ぶか、先にGPX照合を実行してください")
        for video in videos:
            argv += ["--video", f"{Path(video).stem}={video}"]
        return ("候補検出", argv)

    if step == "library":
        argv = [py, "pipeline/build_library.py",
                "--out-dir", "pipeline/data/library",
                "--photos-dir", "Source/photos"]
        for video in videos:
            argv += ["--video", f"{Path(video).stem}={video}"]
        if params.get("interval_s"):
            argv += ["--interval-s", str(params["interval_s"])]
        return ("画像ライブラリの作成", argv)

    if step == "adopt_all":
        if not mountain_id or not mountain_name:
            raise ValueError("山IDと山名を入力してください")
        return ("候補を全採用（レビュー省略）", [
            py, "pipeline/adopt_candidates.py",
            "--candidates", "pipeline/data/candidates.json",
            "--mountain-id", mountain_id, "--mountain-name", mountain_name,
            "--out", "pipeline/data/confirmed_points.json",
        ])

    if step == "frames":
        argv = [py, "pipeline/extract_frames.py", "final",
                "--confirmed", "pipeline/data/confirmed_points.json",
                "--out-dir", "pipeline/data/frames"]
        for video in videos:
            argv += ["--video", f"{Path(video).stem}={video}"]
        return ("出題用画像の書き出し", argv)

    if step == "build":
        argv = [py, "pipeline/build_quiz_data.py",
                "--confirmed", "pipeline/data/confirmed_points.json",
                "--public-dir", "public"]
        if gpx:
            argv += ["--gpx", gpx]
        if (ROOT / "pipeline/data/frames").exists():
            argv += ["--images-dir", "pipeline/data/frames"]
        return ("出題データ生成", argv)

    raise ValueError(f"未知の工程です: {step}")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class StudioHandler(http.server.BaseHTTPRequestHandler):
    server_version = "YamaGuessrStudio/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass  # アクセスログは出さない（実行ログだけ見せる）

    # -- 共通 --------------------------------------------------------------
    def _json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    # -- ルーティング -------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if not self._is_local():
            self.send_error(403, "localhost only")
            return
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route in ("/", "/index.html"):
            self._file(PIPELINE / "studio.html")
            return
        if route == "/api/state":
            self._json(list_state())
            return
        if route == "/api/log":
            query = urllib.parse.parse_qs(parsed.query)
            job = Job.get((query.get("id") or [""])[0])
            if not job:
                self._json({"error": "そのジョブはありません"}, 404)
                return
            offset = int((query.get("offset") or ["0"])[0])
            self._json(job.snapshot(offset))
            return
        # レビューツールと中間データ・公開データ、レビューが使う地図ライブラリを配る。
        # （地図ライブラリを配らないと、review.html を studio から開いたとき地図が出ない）
        rel = route.lstrip("/")
        if rel.startswith(("pipeline/", "public/", VENDOR_PREFIX)):
            self._file(ROOT / rel)
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if not self._is_local():
            self.send_error(403, "localhost only")
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/upload":
            self._handle_upload(parsed)
            return
        if parsed.path not in ("/api/run", "/api/confirmed"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            params = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json({"error": "リクエストを解釈できませんでした"}, 400)
            return
        if parsed.path == "/api/confirmed":
            try:
                self._json(save_confirmed(params))
            except (ValueError, OSError) as e:
                self._json({"error": str(e)}, 400)
            return
        step = params.get("step")
        if step not in STEPS:
            self._json({"error": f"未知の工程です: {step}"}, 400)
            return
        try:
            label, argv = build_argv(step, params)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
            return
        job = Job(label, argv).start()
        self._json({"id": job.id, "label": label})

    def _handle_upload(self, parsed: urllib.parse.ParseResult) -> None:
        """`?kind=photo&name=IMG_0001.jpg` ＋ 本体がそのままファイル、という形で受ける。

        multipart を解く標準ライブラリ（cgi）が Python 3.13 で消えたので、
        自前のUIからは生バイトで送る単純な形にしている。
        """
        query = urllib.parse.parse_qs(parsed.query)
        kind = (query.get("kind") or [""])[0]
        name = (query.get("name") or [""])[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json({"error": "中身が空です"}, 400)
            return
        if length > MAX_UPLOAD_BYTES:
            self._json({"error": "ファイルが大きすぎます"}, 413)
            return
        data = self.rfile.read(length)
        try:
            info = save_upload(kind, name, data)
        except (ValueError, OSError) as e:
            self._json({"error": str(e)}, 400)
            return
        self._json(info)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="出題データ追加のローカルUI")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{args.port}/"
    # 127.0.0.1 にだけ待ち受ける（同じLANの他の端末からも見えない）
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), StudioHandler)
    print(f"YamaGuessr Studio: {url}")
    print("ローカル専用です。Ctrl+C で終了します。")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
