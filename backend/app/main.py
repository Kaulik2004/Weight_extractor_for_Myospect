"""FastAPI application: video upload, frame access, AI/OCR extraction and CSV export."""
from __future__ import annotations

import csv
import hmac
import io
import logging
import os
import string
import sys
from pathlib import Path
from typing import Optional

import cv2
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import config, pipeline, video_store
from .config import CORS_ORIGIN_REGEX, CORS_ORIGINS, EXPORT_DIR, FRONTEND_DIST
from .ocr import available_engines, is_ai, not_configured_message
from .schemas import CsvExportRequest, CsvRow, ExtractRequest, TestRequest, VideoMeta

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Weight Extractor API", version="1.0.0")

_OPEN_PATHS = {"/api/health"}


def _password_ok(given: str) -> bool:
    return hmac.compare_digest(given.encode("utf-8"), config.APP_PASSWORD.encode("utf-8"))


# Registered before CORS so CORS stays the outer layer: preflights are answered
# and 401s still carry CORS headers the browser can read.
@app.middleware("http")
async def _require_password(request: Request, call_next):
    if (
        config.APP_PASSWORD
        and request.method != "OPTIONS"
        and request.url.path.startswith("/api/")
        and request.url.path not in _OPEN_PATHS
    ):
        # Header for fetch/XHR; query parameter for <img src> frame URLs, which can't send headers.
        given = request.headers.get("x-app-password") or request.query_params.get("key") or ""
        if not _password_ok(given):
            return JSONResponse(status_code=401, content={"detail": "Password required"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(video_store.VideoNotFound)
async def _not_found(_: Request, exc: video_store.VideoNotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(video_store.VideoError)
async def _video_error(_: Request, exc: video_store.VideoError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return not config.PUBLIC and host in {"127.0.0.1", "::1", "localhost", "testclient"}


def require_local(request: Request) -> None:
    """File-system routes touch the host disk, so only loopback clients may use them."""
    if not _is_local(request):
        raise HTTPException(403, "File-system access is only allowed from this machine")


# --------------------------------------------------------------------------- #
# Health / auth
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health(request: Request):
    return {
        "status": "ok",
        "engines": available_engines(),
        "auth_required": bool(config.APP_PASSWORD),
        # Whether the "save to a path on this machine" export can work for this client.
        "fs_access": _is_local(request),
    }


@app.get("/api/auth")
def auth_check():
    """Protected by the password middleware: 200 means the password is right."""
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Videos
# --------------------------------------------------------------------------- #
@app.post("/api/videos", response_model=VideoMeta, status_code=201)
async def upload_video(file: UploadFile = File(...)):
    return await run_in_threadpool(video_store.save_upload, file.file, file.filename or "")


@app.get("/api/videos/{video_id}", response_model=VideoMeta)
def get_video(video_id: str):
    return video_store.get_meta(video_id)


@app.delete("/api/videos/{video_id}", status_code=204)
def delete_video(video_id: str):
    video_store.delete(video_id)
    return Response(status_code=204)


@app.get("/api/videos/{video_id}/file")
def video_file(video_id: str):
    """Raw video with HTTP range support (for players that can decode it)."""
    return FileResponse(video_store.get_path(video_id))


@app.get("/api/videos/{video_id}/frames/{index}")
def get_frame(
    video_id: str,
    index: int,
    max_width: int = Query(1280, ge=64, le=4096),
    quality: int = Query(80, ge=30, le=95),
):
    """One decoded frame as JPEG. Used for codecs the browser cannot play (e.g. AVI)."""
    meta = video_store.get_meta(video_id)
    if not 0 <= index < meta.frame_count:
        raise HTTPException(404, "Frame index out of range")
    frame = video_store.read_frame(video_id, index)
    if frame.shape[1] > max_width:
        k = max_width / frame.shape[1]
        frame = cv2.resize(frame, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    return Response(
        content=video_store.encode_jpeg(frame, quality),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


def _check_engine(engine: str, roi) -> None:
    if not available_engines().get(engine):
        raise HTTPException(400, not_configured_message(engine))
    if roi is None and not is_ai(engine):
        raise HTTPException(400, "EasyOCR needs an ROI: draw a box around the display first")


@app.post("/api/videos/{video_id}/ocr-test")
def ocr_test(video_id: str, req: TestRequest):
    """Read one frame and return what the engine saw and what it read."""
    meta = video_store.get_meta(video_id)
    if req.frame_index >= meta.frame_count:
        raise HTTPException(404, "Frame index out of range")
    _check_engine(req.options.engine, req.roi)
    frame = video_store.read_frame(video_id, req.frame_index)
    timestamp = round(req.frame_index / meta.fps, 4)
    try:
        res = pipeline.analyse_frame(frame, req.frame_index, timestamp, req.roi, req.options, with_preview=True)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))
    model_input = res.pop("_input")
    return {
        **res,
        "frame_index": req.frame_index,
        "timestamp": timestamp,
        "input_image": pipeline._data_url(model_input, quality=90),
    }


@app.post("/api/videos/{video_id}/extract")
async def extract(video_id: str, req: ExtractRequest):
    """Stream readings as NDJSON: one JSON event per line.

    Events: ``start`` -> ``frame`` x N -> ``done`` (or ``error`` / ``cancelled``).
    Closing the connection cancels the job.
    """
    meta = video_store.get_meta(video_id)
    _check_engine(req.options.engine, req.roi)
    return StreamingResponse(
        pipeline.ndjson_stream(meta, req),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# CSV export and local file-system browsing
# --------------------------------------------------------------------------- #
def build_csv(rows: list[CsvRow], unit: str, include_extras: bool) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    header = ["timestamp", "frame_index", "weight_value"]
    if include_extras:
        header += ["unit", "confidence", "edited"]
    w.writerow(header)
    for r in sorted(rows, key=lambda r: r.frame_index):
        line = [f"{r.timestamp:.4f}", r.frame_index, "" if r.weight_value is None else r.weight_value]
        if include_extras:
            line += [unit, "" if r.confidence is None else f"{r.confidence:.4f}", int(r.edited)]
        w.writerow(line)
    return buf.getvalue()


_BAD_NAME_CHARS = set('<>:"/\\|?*') | {chr(i) for i in range(32)}


def _safe_filename(name: str) -> str:
    name = "".join(c for c in Path(name).name if c not in _BAD_NAME_CHARS).strip(" .")
    if not name:
        name = "weights"
    if not name.lower().endswith(".csv"):
        name += ".csv"
    return name


@app.post("/api/export/csv", dependencies=[Depends(require_local)])
def export_csv(req: CsvExportRequest):
    directory = Path(os.path.expanduser(req.directory or str(EXPORT_DIR))).resolve()
    if not directory.is_dir():
        raise HTTPException(400, f"Directory does not exist: {directory}")
    target = directory / _safe_filename(req.filename)
    if target.exists() and not req.overwrite:
        stem, n = target.stem, 1
        while target.exists():
            target = directory / f"{stem}_{n}.csv"
            n += 1
    try:
        target.write_text(build_csv(req.rows, req.unit, req.include_extras), encoding="utf-8", newline="")
    except OSError as exc:
        raise HTTPException(400, f"Could not write file: {exc}")
    return {"path": str(target), "rows": len(req.rows), "bytes": target.stat().st_size}


def _roots() -> list[str]:
    if sys.platform == "win32":
        return [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
    return ["/"]


@app.get("/api/fs/list", dependencies=[Depends(require_local)])
def fs_list(path: Optional[str] = None):
    """List sub-directories so the UI can offer a folder picker in any browser."""
    base = Path(os.path.expanduser(path or "~")).resolve()
    if not base.is_dir():
        raise HTTPException(400, f"Not a directory: {base}")
    dirs = []
    try:
        for entry in sorted(os.scandir(base), key=lambda e: e.name.lower()):
            try:
                if entry.is_dir() and not entry.name.startswith((".", "$")):
                    dirs.append({"name": entry.name, "path": str(Path(entry.path))})
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {base}")
    parent = str(base.parent) if base.parent != base else None
    return {
        "path": str(base),
        "parent": parent,
        "dirs": dirs,
        "roots": _roots(),
        "home": str(Path.home()),
        "default_export": str(EXPORT_DIR),
    }


# --------------------------------------------------------------------------- #
# Production: serve the built React app from the same origin
# --------------------------------------------------------------------------- #
if FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        candidate = (FRONTEND_DIST / full_path).resolve()
        if full_path and candidate.is_file() and FRONTEND_DIST in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
