"""Frame sampling -> AI vision reading (or EasyOCR) -> JSON events."""
from __future__ import annotations

import asyncio
import base64
import itertools
import json
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, AsyncIterator, Iterator, Optional

import cv2
import numpy as np

from . import video_store
from .ocr import ai, finalize, is_ai, run_easyocr
from .ocr.preprocess import Prepared, prepare
from .ocr.types import OcrResult
from .schemas import ROI, ExtractRequest, OCROptions, VideoMeta

NEON = (247, 85, 168)  # BGR of #A855F7
NEON_DIM = (206, 34, 126)  # BGR of #7E22CE
PREVIEW_HEIGHT = 140


def _data_url(img: np.ndarray, quality: int = 80) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(
        video_store.encode_jpeg(img, quality)
    ).decode("ascii")


def _preview(img: np.ndarray) -> np.ndarray:
    """Downscale an image to live-feed size."""
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    k = PREVIEW_HEIGHT / max(img.shape[0], 1)
    k = min(k, 800 / max(img.shape[1], 1))
    return cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)


def annotate(p: Prepared, result) -> np.ndarray:
    """Draw neon boxes and labels over the (rotated) ROI crop (EasyOCR detections)."""
    vis = _preview(p.crop)
    # Detection boxes are in processed-image pixels: convert via the upscale factor.
    f = (vis.shape[0] / max(p.crop.shape[0], 1)) / p.scale
    for d in result.detections:
        x0, y0 = int(d.x * f), int(d.y * f)
        x1, y1 = int((d.x + d.w) * f), int((d.y + d.h) * f)
        colour = NEON if d.conf >= 0.5 else NEON_DIM
        cv2.rectangle(vis, (x0, y0), (x1, y1), colour, 2, cv2.LINE_AA)
        cv2.putText(vis, d.text, (x0 + 2, max(12, y0 - 4)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, colour, 1, cv2.LINE_AA)
    return vis


def _boxes(p: Prepared, result) -> list[dict[str, Any]]:
    """Detection boxes normalised to the processed ROI (0..1)."""
    H, W = p.binary.shape[:2]
    return [
        {
            "x": round(d.x / W, 4),
            "y": round(d.y / H, 4),
            "w": round(d.w / W, 4),
            "h": round(d.h / H, 4),
            "text": d.text,
            "conf": round(d.conf, 3),
        }
        for d in result.detections
    ]


def _result_fields(result: OcrResult, t0: float) -> dict:
    return {
        "text": result.text,
        "value": result.value,
        "confidence": result.confidence,
        "engine": result.engine,
        "flags": result.flags,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def analyse_frame(frame: np.ndarray, frame_index: int, timestamp: float, roi: Optional[ROI],
                  opts: OCROptions, with_preview: bool) -> dict:
    """Read one frame. ``_input`` holds the image the engine actually looked at."""
    t0 = time.perf_counter()
    if is_ai(opts.engine):
        img = ai.model_image(frame, roi, opts)
        inp = ai.FrameInput(frame_index, timestamp, img)
        result = finalize(ai.read_batch(opts.engine, [inp], opts, whole_frame=roi is None)[0], opts)
        out = {**_result_fields(result, t0), "boxes": [], "_input": img}
        if with_preview:
            out["preview"] = _data_url(_preview(img))
        return out

    if roi is None:
        raise RuntimeError("EasyOCR needs an ROI: draw a box around the display first")
    p = prepare(frame, roi, opts)
    result = finalize(run_easyocr(p, opts), opts)
    out = {**_result_fields(result, t0), "boxes": _boxes(p, result), "_input": p.binary}
    if with_preview:
        out["preview"] = _data_url(annotate(p, result))
    return out


def _roi_tracker(meta: VideoMeta, req: ExtractRequest):
    """Returns a function frame_index -> ROI (None = whole frame), blending toward `roi_end` if set."""
    if req.roi is None or req.roi_end is None:
        return lambda idx: req.roi
    last = meta.frame_count - 1
    end_resolved = last if req.end_frame is None else min(req.end_frame, last)
    start_resolved = max(0, min(req.start_frame, end_resolved))
    span = max(1, end_resolved - start_resolved)

    def roi_at(idx: int) -> ROI:
        t = (idx - start_resolved) / span
        return req.roi.lerp(req.roi_end, t)

    return roi_at


def _chunked(iterable, n: int):
    it = iter(iterable)
    while True:
        chunk = list(itertools.islice(it, n))
        if not chunk:
            return
        yield chunk


def _frame_base(meta: VideoMeta, seq: int, total: int, idx: int) -> dict:
    return {"type": "frame", "seq": seq, "total": total, "frame_index": idx,
            "timestamp": round(idx / meta.fps, 4)}


def _decode_error(base: dict) -> dict:
    return {**base, "text": "", "value": None, "confidence": 0.0, "engine": "",
            "flags": ["decode_error"], "boxes": []}


def run_extraction(meta: VideoMeta, req: ExtractRequest, stop: threading.Event) -> Iterator[dict]:
    indices = video_store.sample_indices(meta.frame_count, req.samples, req.start_frame, req.end_frame)
    total = len(indices)
    roi_at = _roi_tracker(meta, req)
    yield {"type": "start", "total": total, "indices": indices, "fps": meta.fps}

    t_start = time.perf_counter()
    path = video_store.get_path(meta.id)
    frame_iter = video_store.iter_frames(path, indices)
    if is_ai(req.options.engine):
        ok_count = yield from _run_ai_batches(meta, req, roi_at, frame_iter, total, stop)
    else:
        ok_count = yield from _run_sequential(meta, req, roi_at, frame_iter, total, stop)
    if ok_count is None:  # cancelled or errored - the sub-generator already yielded that event
        return

    elapsed = time.perf_counter() - t_start
    yield {
        "type": "done",
        "total": total,
        "recognised": ok_count,
        "elapsed_s": round(elapsed, 2),
        "fps_processed": round(total / elapsed, 2) if elapsed > 0 else None,
    }


def _run_sequential(meta, req, roi_at, frame_iter, total, stop: threading.Event) -> Iterator[dict]:
    """EasyOCR: one frame at a time."""
    ok_count = 0
    # Throttle previews: at most ~25 per second of wall-clock time to keep the stream light.
    last_preview = 0.0
    for seq, (idx, frame) in enumerate(frame_iter):
        if stop.is_set():
            yield {"type": "cancelled", "processed": seq}
            return None
        base = _frame_base(meta, seq, total, idx)
        if frame is None:
            yield _decode_error(base)
            continue
        now = time.perf_counter()
        want_preview = req.include_previews and (now - last_preview >= 0.04 or seq == total - 1)
        try:
            res = analyse_frame(frame, idx, base["timestamp"], roi_at(idx), req.options, want_preview)
        except RuntimeError as exc:  # engine missing etc. - fatal for the job
            yield {"type": "error", "message": str(exc)}
            return None
        res.pop("_input", None)
        if want_preview:
            last_preview = now
        if res["value"] is not None:
            ok_count += 1
        yield {**base, **res}
    return ok_count


def _run_ai_batches(meta, req, roi_at, frame_iter, total, stop: threading.Event) -> Iterator[dict]:
    """AI engines: frames go out in chronological batches, several requests in
    flight at once; results are streamed back in frame order."""
    engine = req.options.engine
    whole_frame = req.roi is None
    workers = ai.concurrency(engine)
    chunks = _chunked(frame_iter, ai.batch_size(engine))
    pending: deque = deque()  # (future, chunk, {frame_index: FrameInput}, submitted_at)
    ok_count = 0
    seq = 0
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"ai-{engine}")
    try:
        exhausted = False
        while True:
            while not exhausted and len(pending) < workers and not stop.is_set():
                chunk = next(chunks, None)
                if chunk is None:
                    exhausted = True
                    break
                inputs = {
                    idx: ai.FrameInput(idx, round(idx / meta.fps, 4), ai.model_image(frame, roi_at(idx), req.options))
                    for idx, frame in chunk if frame is not None
                }
                fut = pool.submit(ai.read_batch, engine, list(inputs.values()), req.options, whole_frame, stop)
                pending.append((fut, chunk, inputs, time.perf_counter()))
            if not pending:
                break

            fut, chunk, inputs, t0 = pending[0]
            while not fut.done() and not stop.is_set():
                wait([fut], timeout=0.25)
            if stop.is_set():
                yield {"type": "cancelled", "processed": seq}
                return None
            pending.popleft()
            try:
                outs = fut.result()
            except ai.AIError as exc:  # bad key / model name etc. - fatal for the job
                yield {"type": "error", "message": str(exc)}
                return None
            results = dict(zip(inputs.keys(), outs))

            for i, (idx, frame) in enumerate(chunk):
                base = _frame_base(meta, seq, total, idx)
                seq += 1
                if frame is None:
                    yield _decode_error(base)
                    continue
                result = finalize(results[idx], req.options)
                res = {**_result_fields(result, t0), "boxes": []}
                if req.include_previews and i == len(chunk) - 1:  # one live-feed image per batch
                    res["preview"] = _data_url(_preview(inputs[idx].image))
                if res["value"] is not None:
                    ok_count += 1
                yield {**base, **res}
        return ok_count
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


async def ndjson_stream(meta: VideoMeta, req: ExtractRequest) -> AsyncIterator[bytes]:
    """Run the extraction in a worker thread and relay its events as NDJSON.

    If the client disconnects, Starlette closes this generator; the ``finally``
    block then signals the worker to stop.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()
    sentinel = object()

    def emit(item: object) -> None:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:  # event loop already closed (server shutting down)
            stop.set()

    def worker() -> None:
        try:
            for event in run_extraction(meta, req, stop):
                emit(event)
        except Exception as exc:  # surface unexpected failures to the client
            emit({"type": "error", "message": repr(exc)})
        finally:
            emit(sentinel)

    thread = threading.Thread(target=worker, name=f"extract-{meta.id[:8]}", daemon=True)
    thread.start()
    try:
        while True:
            event = await queue.get()
            if event is sentinel:
                break
            yield (json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8")
    finally:
        stop.set()
