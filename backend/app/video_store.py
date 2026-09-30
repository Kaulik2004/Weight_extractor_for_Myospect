"""Upload persistence and random-access frame reading."""
from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from typing import BinaryIO, Iterator, Optional

import cv2
import numpy as np

from .config import ALLOWED_EXTENSIONS, UPLOAD_DIR
from .schemas import VideoMeta

_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Forward seeks shorter than this are done by grabbing frames sequentially,
# which is faster and more frame-accurate than CAP_PROP_POS_FRAMES seeking.
_SEQUENTIAL_GAP = 48


class VideoError(Exception):
    """Raised for any user-facing video problem."""


class VideoNotFound(VideoError):
    pass


def _check_id(video_id: str) -> str:
    # Ids are uuid4 hex strings; validating them blocks path traversal.
    if not _ID_RE.match(video_id or ""):
        raise VideoNotFound("Invalid video id")
    return video_id


def _meta_path(video_id: str) -> Path:
    return UPLOAD_DIR / f"{_check_id(video_id)}.json"


def probe(path: Path) -> dict:
    """Read fps, frame count and real (rotation-corrected) frame size."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise VideoError("OpenCV could not open this video (unsupported codec?)")
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise VideoError("Video contains no decodable frames")
        # The decoded frame already honours rotation metadata, unlike CAP_PROP_FRAME_WIDTH.
        height, width = frame.shape[:2]
        if not (0 < fps <= 1000):
            fps = 30.0
        if count <= 0:
            count = 1
            while cap.grab():
                count += 1
        return {
            "fps": fps,
            "frame_count": count,
            "duration": count / fps,
            "width": int(width),
            "height": int(height),
        }
    finally:
        cap.release()


def save_upload(fileobj: BinaryIO, filename: str) -> VideoMeta:
    ext = Path(filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise VideoError(
            f"Unsupported file type '{ext or '?'}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )
    video_id = uuid.uuid4().hex
    dest = UPLOAD_DIR / f"{video_id}{ext}"
    with dest.open("wb") as out:
        shutil.copyfileobj(fileobj, out, length=4 * 1024 * 1024)
    try:
        info = probe(dest)
    except VideoError:
        dest.unlink(missing_ok=True)
        raise
    meta = VideoMeta(
        id=video_id,
        filename=Path(filename).name,
        size_bytes=dest.stat().st_size,
        **info,
    )
    _meta_path(video_id).write_text(
        json.dumps({**meta.model_dump(), "path": str(dest)}), encoding="utf-8"
    )
    return meta


def _load_raw(video_id: str) -> dict:
    p = _meta_path(video_id)
    if not p.exists():
        raise VideoNotFound("Video not found")
    return json.loads(p.read_text(encoding="utf-8"))


def get_meta(video_id: str) -> VideoMeta:
    raw = _load_raw(video_id)
    raw.pop("path", None)
    return VideoMeta(**raw)


def get_path(video_id: str) -> Path:
    return Path(_load_raw(video_id)["path"])


def delete(video_id: str) -> None:
    raw = _load_raw(video_id)
    Path(raw["path"]).unlink(missing_ok=True)
    _meta_path(video_id).unlink(missing_ok=True)


def read_frame(video_id: str, index: int) -> np.ndarray:
    for _, frame in iter_frames(get_path(video_id), [index]):
        if frame is None:
            raise VideoError(f"Could not decode frame {index}")
        return frame
    raise VideoError(f"Could not decode frame {index}")


def iter_frames(path: Path, indices: list[int]) -> Iterator[tuple[int, Optional[np.ndarray]]]:
    """Yield (index, frame) for a sorted list of indices using the cheapest access pattern."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise VideoError("Could not open video")
    try:
        pos = 0  # index of the frame the next cap.read() returns
        for idx in indices:
            gap = idx - pos
            if gap < 0 or gap > _SEQUENTIAL_GAP:
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            else:
                for _ in range(gap):
                    cap.grab()
            ok, frame = cap.read()
            pos = idx + 1
            yield idx, (frame if ok else None)
    finally:
        cap.release()


def sample_indices(
    frame_count: int, samples: int, start: int = 0, end: Optional[int] = None
) -> list[int]:
    """N evenly spaced frame indices across [start, end], both inclusive."""
    last = max(0, frame_count - 1)
    end = last if end is None else min(end, last)
    start = max(0, min(start, end))
    n = max(1, min(samples, end - start + 1))
    if n == 1:
        return [start]
    return sorted({int(round(i)) for i in np.linspace(start, end, n)})


def encode_jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise VideoError("JPEG encoding failed")
    return buf.tobytes()
