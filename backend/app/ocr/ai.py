"""Vision-LLM engines: read the scale the way a chat assistant does.

Uploading a clip to Gemini or Claude in the browser works well because a
strong vision model sees the display in colour, at a decent size, and sees
many frames of the same recording together. This module reproduces that:

* each sampled frame is sent as a colour image - either the ROI with a margin
  of context, or the whole frame when no ROI is drawn (no thresholding);
* frames go out in large chronological batches, each labelled with its frame
  number and timestamp, so the model can cross-check neighbouring frames;
* one detailed prompt (``build_prompt``) and a JSON reply keyed by frame
  number, so every reading lands on the right row.

Providers: ``gemini``, ``claude`` (Anthropic SDK), ``openai``, ``groq``.
Each is enabled by its API key in ``backend/.env``.
"""
from __future__ import annotations

import base64
import json
import logging
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Optional

import cv2
import numpy as np

from .. import config
from ..schemas import ROI, OCROptions
from .types import EngineOutput

log = logging.getLogger(__name__)


class AIError(RuntimeError):
    """Non-recoverable (bad key, unknown model, malformed request): stops the job."""


class AITransientError(RuntimeError):
    """Rate limit / outage / refusal that outlasted the retries: only this batch fails."""


@dataclass
class FrameInput:
    frame_index: int
    timestamp: float
    image: np.ndarray  # BGR image exactly as the model will see it


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
_ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
_CROP_MARGIN = 0.15  # context around the ROI on each side, as a fraction of its size
_CROP_MIN_SHORT_SIDE = 360
_CROP_MAX_LONG_SIDE = 1024
_FRAME_MAX_LONG_SIDE = 1536


def model_image(frame: np.ndarray, roi: Optional[ROI], opts: OCROptions) -> np.ndarray:
    """The image sent to the model: the ROI plus some margin, or the whole frame."""
    if roi is None:
        img, max_long = frame, _FRAME_MAX_LONG_SIDE
    else:
        H, W = frame.shape[:2]
        x, y, w, h = roi.to_pixels(W, H)
        mx, my = int(w * _CROP_MARGIN), int(h * _CROP_MARGIN)
        img = frame[max(0, y - my) : min(H, y + h + my), max(0, x - mx) : min(W, x + w + mx)]
        max_long = _CROP_MAX_LONG_SIDE
    if opts.rotate in _ROTATIONS:
        img = cv2.rotate(img, _ROTATIONS[opts.rotate])

    h, w = img.shape[:2]
    k = min(1.0, max_long / max(h, w))
    if roi is not None and min(h, w) * k < _CROP_MIN_SHORT_SIDE:
        # Small displays: enlarge so thin segments and the decimal point survive.
        k = min(_CROP_MIN_SHORT_SIDE / min(h, w), max_long / max(h, w))
    if k != 1.0:
        interp = cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA
        img = cv2.resize(img, None, fx=k, fy=k, interpolation=interp)
    return img


def _b64_jpeg(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise AIError("JPEG encoding failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


# --------------------------------------------------------------------------- #
# Prompt
# --------------------------------------------------------------------------- #
_PROMPT = """\
You are extracting a time series of weight readings from a video of a digital weighing scale.

You will receive {n} image{s}. They are frames sampled from ONE continuous recording, in \
chronological order, and each image is preceded by a label giving its frame number and \
timestamp. {framing}

For every image, read the number currently shown on the scale's main weight display.

How to read the display:
- Read exactly what the display shows in THAT frame. Scale digits are usually seven-segment \
LCD/LED digits: check every segment, because 1/7, 0/8, 5/6, 6/8, 8/9 and 3/9 are easy to \
confuse. A "1" lights only the two right-hand segments. Many displays also show the unlit \
segments faintly ("ghost" segments, e.g. a dim 8 behind every digit): count only the segments \
that are clearly lit, and ignore leading positions where nothing is lit.
- The decimal point is a small dot at the bottom between two digits and is easy to miss or to \
confuse with glare. A scale does not move its decimal point during a recording, so if you can \
see it clearly in some frames, it is in the same position in the others.{decimals}
- Include a minus sign only if the display actually shows one.{negative}
- Ignore unit labels (kg, lb, g, oz), stability/zero/tare/battery indicators, and any other \
numbers in view (clock, tare memory, price, secondary displays, text on the scale body).{range}
- Consecutive frames come from the same recording, so the reading stays the same or changes \
gradually between neighbours. Use neighbouring frames only to resolve a digit that is \
genuinely ambiguous in its own frame (motion blur, glare, a digit caught mid-change). Never \
copy a neighbour's value into a frame whose display you can read, and never invent a value \
for a frame where the display cannot be seen.
- If the display is blank, off, out of view, fully obscured, or shows something other than a \
number (for example "----", "Err", "LO"), give an empty string for that frame.

Set "certain" to true when every digit and the decimal point were clearly legible in that \
frame, and false when you had to infer any part of the reading.

Reply with JSON only, in exactly this shape, with one entry per image in the same order:
{{"readings": [{{"frame": <frame number from the label>, "value": "<the number as shown, \
e.g. \\"72.40\\" or \\"-0.5\\">", "certain": <true or false>}}]}}"""

_FRAMING_CROP = (
    "Each image is cropped around the scale's display (with a small margin), so the display "
    "fills most of the image."
)
_FRAMING_WHOLE = (
    "Each image is a full video frame. Find the weighing scale's digital weight display in it "
    "(it is in roughly the same place in every frame) and read that display."
)


def build_prompt(n: int, whole_frame: bool, opts: OCROptions) -> str:
    if opts.decimals is None:
        decimals = ""
    elif opts.decimals == 0:
        decimals = " This scale shows whole numbers only (no decimal point)."
    else:
        decimals = (
            f" This scale shows exactly {opts.decimals} digit{'s' if opts.decimals > 1 else ''} "
            "after the decimal point."
        )
    if opts.min_value is not None and opts.max_value is not None:
        rng = f" Plausible readings for this recording lie between {opts.min_value:g} and {opts.max_value:g}."
    elif opts.min_value is not None:
        rng = f" Plausible readings for this recording are at least {opts.min_value:g}."
    elif opts.max_value is not None:
        rng = f" Plausible readings for this recording are at most {opts.max_value:g}."
    else:
        rng = ""
    return _PROMPT.format(
        n=n,
        s="" if n == 1 else "s",
        framing=_FRAMING_WHOLE if whole_frame else _FRAMING_CROP,
        decimals=decimals,
        negative="" if opts.allow_negative else " This scale never shows negative readings.",
        range=rng,
    )


def frame_label(i: int, n: int, f: FrameInput) -> str:
    return f"Image {i + 1}/{n} - frame {f.frame_index}, t = {f.timestamp:.3f} s"


# Every provider gets the same interleaved content: prompt, then label + image per frame.
# ("text", str) | ("image", base64 JPEG)
Part = tuple[str, str]


def build_parts(frames: list[FrameInput], opts: OCROptions, whole_frame: bool) -> list[Part]:
    n = len(frames)
    parts: list[Part] = [("text", build_prompt(n, whole_frame, opts))]
    for i, f in enumerate(frames):
        parts.append(("text", frame_label(i, n, f)))
        parts.append(("image", _b64_jpeg(f.image)))
    return parts


# JSON Schema for providers with structured outputs. "value" is a string so that
# trailing zeros survive ("72.40"); an empty string means unreadable.
READINGS_SCHEMA = {
    "type": "object",
    "properties": {
        "readings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "frame": {"type": "integer"},
                    "value": {"type": "string"},
                    "certain": {"type": "boolean"},
                },
                "required": ["frame", "value", "certain"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["readings"],
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Reply parsing
# --------------------------------------------------------------------------- #
_CONF_CERTAIN = 0.95
_CONF_UNSURE = 0.5  # below the UI's 0.6 review threshold, so these get flagged


def _find_readings(raw: str) -> Optional[list]:
    """The last JSON value in `raw` that holds the readings (tolerates <think> text, fences, ...)."""
    decoder = json.JSONDecoder()
    found = None
    i = 0
    while True:
        starts = [p for p in (raw.find("{", i), raw.find("[", i)) if p >= 0]
        if not starts:
            return found
        i = min(starts)
        try:
            obj, end = decoder.raw_decode(raw, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict) and isinstance(obj.get("readings"), list):
            found = obj["readings"]
        elif isinstance(obj, list) and obj and all(isinstance(x, dict) for x in obj):
            found = obj
        i = end


def _clean_value(v) -> str:
    if v is None:
        return ""
    text = str(v).strip()
    return "" if text.lower() in {"", "none", "null", "n/a", "-", "----"} else text


def parse_reply(raw: str, frames: list[FrameInput], engine: str) -> list[EngineOutput]:
    readings = _find_readings(raw or "") or []
    by_frame: dict[int, dict] = {}
    for r in readings:
        try:
            by_frame.setdefault(int(r.get("frame")), r)
        except (TypeError, ValueError):
            pass
    keyed = all(f.frame_index in by_frame for f in frames)

    outs: list[EngineOutput] = []
    for i, f in enumerate(frames):
        r = by_frame.get(f.frame_index) if keyed else (readings[i] if i < len(readings) else None)
        if r is None:
            outs.append(EngineOutput(text="", confidence=0.0, engine=engine, flags=["model_skipped"]))
            continue
        text = _clean_value(r.get("value"))
        certain = r.get("certain")
        conf = 0.0 if not text else (_CONF_UNSURE if certain is False else _CONF_CERTAIN)
        outs.append(EngineOutput(text=text, confidence=conf, engine=engine))
    return outs


# --------------------------------------------------------------------------- #
# HTTP helper (Gemini, OpenAI, Groq)
# --------------------------------------------------------------------------- #
_RETRY_STATUS = {408, 429, 500, 502, 503, 504, 529}
_MAX_ATTEMPTS = 4
_MAX_RETRY_WAIT = 75.0  # covers a full per-minute rate-limit window
_HTTP_TIMEOUT = 300


def _sleep(seconds: float, stop: Optional[threading.Event]) -> bool:
    """Sleep in short steps; False if the job was cancelled meanwhile."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if stop is not None and stop.is_set():
            return False
        time.sleep(min(0.5, end - time.monotonic()))
    return True


def _error_text(resp) -> str:
    try:
        body = resp.json()
        err = body.get("error", body) if isinstance(body, dict) else body
        msg = err.get("message") if isinstance(err, dict) else str(err)
    except ValueError:
        msg = resp.text[:300]
    return f"{resp.status_code}: {msg}"


def _post_json(provider: str, url: str, headers: dict, payload: dict,
               stop: Optional[threading.Event]) -> dict:
    import requests

    delay = 4.0
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)
        except requests.RequestException as exc:
            err: Exception = AITransientError(f"{provider} request failed: {exc}")
            wait = delay
        else:
            if resp.ok:
                return resp.json()
            if resp.status_code not in _RETRY_STATUS:
                raise AIError(f"{provider} API error {_error_text(resp)}")
            err = AITransientError(f"{provider} API error {_error_text(resp)}")
            try:
                wait = float(resp.headers.get("Retry-After", ""))
            except ValueError:
                wait = delay
        if attempt == _MAX_ATTEMPTS - 1:
            raise err
        log.info("%s: %s - retrying in %.0fs", provider, err, wait)
        if not _sleep(min(max(wait, 1.0), _MAX_RETRY_WAIT), stop):
            raise AITransientError("cancelled")
        delay *= 2
    raise AssertionError("unreachable")


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
def _call_gemini(parts: list[Part], n: int, stop) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.GEMINI_MODEL}:generateContent"
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": v} if kind == "text" else {"inline_data": {"mime_type": "image/jpeg", "data": v}}
                for kind, v in parts
            ],
        }],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    headers = {"x-goog-api-key": config.GEMINI_API_KEY}
    data = _post_json("Gemini", url, headers, payload, stop)
    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates")
        raise AITransientError(f"Gemini returned no answer ({reason})")
    content = candidates[0].get("content") or {}
    return "".join(p.get("text", "") for p in content.get("parts", []) if not p.get("thought"))


@lru_cache(maxsize=1)
def _claude_client():
    import anthropic

    return anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=4, timeout=_HTTP_TIMEOUT)


def _call_claude(parts: list[Part], n: int, stop) -> str:
    import anthropic

    content = [
        {"type": "text", "text": v} if kind == "text"
        else {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": v}}
        for kind, v in parts
    ]
    try:
        msg = _claude_client().beta.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=16000,
            messages=[{"role": "user", "content": content}],
            output_config={"format": {"type": "json_schema", "schema": READINGS_SCHEMA}},
            # If a safety classifier ever declines, re-run on Anthropic's recommended fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIConnectionError as exc:
        raise AITransientError(f"Claude request failed: {exc}") from exc
    except anthropic.APIStatusError as exc:
        text = f"Claude API error {exc.status_code}: {exc.message}"
        if exc.status_code in _RETRY_STATUS:
            raise AITransientError(text) from exc
        raise AIError(text) from exc
    if msg.stop_reason == "refusal":
        raise AITransientError("Claude declined to read this batch")
    return "".join(b.text for b in msg.content if b.type == "text")


def _call_openai(parts: list[Part], n: int, stop) -> str:
    payload = {
        "model": config.OPENAI_MODEL,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": v} if kind == "text"
                else {"type": "input_image", "image_url": f"data:image/jpeg;base64,{v}", "detail": "high"}
                for kind, v in parts
            ],
        }],
        "text": {"format": {"type": "json_schema", "name": "scale_readings",
                            "schema": READINGS_SCHEMA, "strict": True}},
    }
    headers = {"Authorization": f"Bearer {config.OPENAI_API_KEY}"}
    data = _post_json("OpenAI", "https://api.openai.com/v1/responses", headers, payload, stop)
    return "".join(
        c.get("text", "")
        for item in data.get("output", []) if item.get("type") == "message"
        for c in item.get("content", []) if c.get("type") == "output_text"
    )


def _call_groq(parts: list[Part], n: int, stop) -> str:
    payload = {
        "model": config.GROQ_MODEL,
        "temperature": 0,
        "max_tokens": 1024 + 60 * n,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": v} if kind == "text"
                else {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{v}"}}
                for kind, v in parts
            ],
        }],
    }
    headers = {"Authorization": f"Bearer {config.GROQ_API_KEY}"}
    data = _post_json("Groq", "https://api.groq.com/openai/v1/chat/completions", headers, payload, stop)
    return data["choices"][0]["message"]["content"] or ""


_PROVIDERS: dict[str, Callable[[list[Part], int, Optional[threading.Event]], str]] = {
    "gemini": _call_gemini,
    "claude": _call_claude,
    "openai": _call_openai,
    "groq": _call_groq,
}

_KEY_NAMES = {
    "gemini": "GEMINI_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
}


def _module_installed(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


def available() -> dict[str, bool]:
    return {
        "gemini": bool(config.GEMINI_API_KEY) and _module_installed("requests"),
        "claude": bool(config.ANTHROPIC_API_KEY) and _module_installed("anthropic"),
        "openai": bool(config.OPENAI_API_KEY) and _module_installed("requests"),
        "groq": bool(config.GROQ_API_KEY) and _module_installed("requests"),
    }


def not_configured_message(engine: str) -> str:
    return (
        f"The {engine} engine is not configured: set {_KEY_NAMES[engine]} in backend/.env "
        "(see backend/.env.example), install requirements.txt, and restart the backend."
    )


def batch_size(engine: str) -> int:
    return max(1, config.GROQ_BATCH_SIZE if engine == "groq" else config.AI_BATCH_SIZE)


def concurrency(engine: str) -> int:
    # Groq's free tier allows a few thousand image tokens per minute: go one at a time.
    return 1 if engine == "groq" else max(1, config.AI_CONCURRENCY)


def read_batch(engine: str, frames: list[FrameInput], opts: OCROptions, whole_frame: bool,
               stop: Optional[threading.Event] = None) -> list[EngineOutput]:
    """Read every frame in one request. Raises AIError on configuration problems;
    transient failures come back as empty readings flagged ``model_error``."""
    if not frames:
        return []
    if not available().get(engine):
        raise AIError(not_configured_message(engine))
    parts = build_parts(frames, opts, whole_frame)
    try:
        raw = _PROVIDERS[engine](parts, len(frames), stop)
    except AITransientError as exc:
        log.warning("%s batch of %d frames failed: %s", engine, len(frames), exc)
        return [EngineOutput(text="", confidence=0.0, engine=engine, flags=["model_error"]) for _ in frames]
    return parse_reply(raw, frames, engine)
