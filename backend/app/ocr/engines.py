"""OCR engine registry.

* ``gemini`` / ``claude`` / ``openai`` / ``groq`` - vision LLMs that read the
  display from colour frames, in batches (see ``ai.py``). Need an API key.
* ``easyocr`` - local deep-learning OCR on the preprocessed ROI (optional, heavy).
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

import numpy as np

from ..schemas import AI_ENGINES, OCROptions
from . import ai
from .parse import parse_value
from .preprocess import Prepared
from .types import Detection, EngineOutput, OcrResult

log = logging.getLogger(__name__)

_DIGIT_WHITELIST = "0123456789.-"


# --------------------------------------------------------------------------- #
# EasyOCR
# --------------------------------------------------------------------------- #
_easy_lock = threading.Lock()
_easy_reader = None
_easy_checked: Optional[bool] = None


def _easyocr_available() -> bool:
    global _easy_checked
    if _easy_checked is None:
        try:
            import importlib.util

            _easy_checked = importlib.util.find_spec("easyocr") is not None
        except Exception:
            _easy_checked = False
    return _easy_checked


def _get_easy_reader():
    global _easy_reader
    if _easy_reader is None:
        import easyocr  # type: ignore

        try:
            import torch  # type: ignore

            gpu = bool(torch.cuda.is_available())
        except Exception:
            gpu = False
        log.info("Loading EasyOCR model (gpu=%s) ...", gpu)
        _easy_reader = easyocr.Reader(["en"], gpu=gpu, verbose=False)
    return _easy_reader


def run_easyocr(p: Prepared, opts: OCROptions) -> EngineOutput:
    if not _easyocr_available():
        raise RuntimeError("EasyOCR engine is not installed (see requirements-easyocr.txt)")
    img = p.gray if opts.threshold == "none" else p.dark_on_light
    with _easy_lock:  # the reader is not thread-safe
        reader = _get_easy_reader()
        raw = reader.readtext(img, allowlist=_DIGIT_WHITELIST, detail=1, paragraph=False)
    dets: list[Detection] = []
    for box, txt, conf in raw:
        pts = np.array(box, dtype=np.float32)
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        dets.append(
            Detection(int(x0), int(y0), int(x1 - x0), int(y1 - y0), text=str(txt), conf=float(conf))
        )
    dets.sort(key=lambda d: d.x)
    return EngineOutput(
        text="".join(d.text for d in dets),
        confidence=_weighted_conf(dets),
        detections=dets,
        engine="easyocr",
    )


def _weighted_conf(dets: list[Detection]) -> float:
    total = sum(max(len(d.text), 1) for d in dets)
    if not total:
        return 0.0
    return float(sum(d.conf * max(len(d.text), 1) for d in dets) / total)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
def available_engines() -> dict[str, bool]:
    return {**ai.available(), "easyocr": _easyocr_available()}


def is_ai(engine: str) -> bool:
    return engine in AI_ENGINES


def not_configured_message(engine: str) -> str:
    if is_ai(engine):
        return ai.not_configured_message(engine)
    return "EasyOCR engine is not installed (see requirements-easyocr.txt)"


def finalize(out: EngineOutput, opts: OCROptions) -> OcrResult:
    """Turn a raw engine reading into a validated OcrResult (parsing + flags)."""
    value, flags = parse_value(out.text, opts)
    confidence = out.confidence
    if out.flags:
        flags = [f for f in flags if f != "no_digits"] + out.flags
    if value is None:
        confidence = 0.0
    elif "out_of_range" in flags:
        confidence *= 0.5
    return OcrResult(
        text=out.text,
        value=value,
        confidence=round(float(confidence), 4),
        engine=out.engine,
        detections=out.detections,
        flags=flags,
    )
