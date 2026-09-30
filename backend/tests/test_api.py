"""End-to-end tests against a synthetic scale video, with a fake AI provider
standing in for Gemini/Claude/OpenAI (no network, no API keys)."""
from __future__ import annotations

import csv
import json
import math
import re
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from app import config  # noqa: E402
from app.main import app  # noqa: E402
from app.ocr import ai  # noqa: E402
from app.ocr.parse import parse_value  # noqa: E402
from app.schemas import OCROptions  # noqa: E402

ROI = {"x": 0.328, "y": 0.389, "w": 0.344, "h": 0.208}
_LABEL_RE = re.compile(r"frame (\d+), t = ")


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.fixture(scope="session")
def video(tmp_path_factory):
    import make_demo_video as mdv

    out = tmp_path_factory.mktemp("vid") / "demo.mp4"
    argv = sys.argv
    sys.argv = ["x", str(out), "--seconds", "4", "--fps", "25"]
    try:
        mdv.main()
    finally:
        sys.argv = argv
    truth = {}
    with open(out.with_name(out.stem + "_truth.csv")) as fh:
        for row in csv.DictReader(fh):
            truth[int(row["frame_index"])] = float(row["weight_value"])
    return out, truth


@pytest.fixture(scope="session")
def uploaded(client, video):
    path, truth = video
    with open(path, "rb") as fh:
        r = client.post("/api/videos", files={"file": (path.name, fh, "video/mp4")})
    assert r.status_code == 201, r.text
    meta = r.json()
    yield meta, truth
    client.delete(f"/api/videos/{meta['id']}")


class FakeModel:
    """Stands in for a provider: answers from ground truth and records each request."""

    def __init__(self, truth: dict[int, float]):
        self.truth = truth
        self.calls: list[dict] = []
        self.lock = threading.Lock()

    def __call__(self, parts, n, stop):
        texts = [v for kind, v in parts if kind == "text"]
        images = [v for kind, v in parts if kind == "image"]
        frames = [int(m.group(1)) for t in texts for m in [_LABEL_RE.search(t)] if m]
        with self.lock:
            self.calls.append({"prompt": texts[0], "frames": frames, "images": images})
        # Deliberately reversed: results must be matched by frame number, not position.
        readings = [{"frame": f, "value": f"{self.truth[f]:.1f}", "certain": True} for f in reversed(frames)]
        return "```json\n" + json.dumps({"readings": readings}) + "\n```"


@pytest.fixture
def fake_gemini(monkeypatch, video):
    _, truth = video
    fake = FakeModel(truth)
    monkeypatch.setattr(config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setitem(ai._PROVIDERS, "gemini", fake)
    return fake


def _stream(client, video_id, body):
    events = []
    with client.stream("POST", f"/api/videos/{video_id}/extract", json=body) as r:
        assert r.status_code == 200, r.read()
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    return events


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert set(r.json()["engines"]) == {"gemini", "claude", "openai", "groq", "easyocr"}


def test_upload_metadata(uploaded):
    meta, truth = uploaded
    assert meta["frame_count"] == len(truth)
    assert meta["width"] == 1280 and meta["height"] == 720
    assert abs(meta["fps"] - 25) < 0.01


def test_rejects_bad_extension(client):
    r = client.post("/api/videos", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 422


def test_frame_jpeg(client, uploaded):
    meta, _ = uploaded
    r = client.get(f"/api/videos/{meta['id']}/frames/10?max_width=640")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


def test_unconfigured_engine_is_rejected(client, uploaded, monkeypatch):
    meta, _ = uploaded
    monkeypatch.setattr(config, "OPENAI_API_KEY", "")
    body = {"roi": ROI, "samples": 5, "options": {"engine": "openai"}}
    r = client.post(f"/api/videos/{meta['id']}/extract", json=body)
    assert r.status_code == 400 and "OPENAI_API_KEY" in r.json()["detail"]


def test_ai_single_frame(client, uploaded, fake_gemini):
    meta, truth = uploaded
    idx = len(truth) - 1
    r = client.post(
        f"/api/videos/{meta['id']}/ocr-test",
        json={"roi": ROI, "frame_index": idx, "options": {"engine": "gemini"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == pytest.approx(truth[idx])
    assert body["confidence"] > 0.9
    assert body["input_image"].startswith("data:image/jpeg")
    assert fake_gemini.calls[0]["frames"] == [idx]


def test_ai_extract_batches_in_order(client, uploaded, fake_gemini, monkeypatch):
    meta, truth = uploaded
    monkeypatch.setattr(config, "AI_BATCH_SIZE", 7)
    monkeypatch.setattr(config, "AI_CONCURRENCY", 3)
    events = _stream(client, meta["id"], {"roi": ROI, "samples": 40, "options": {"engine": "gemini"}})
    assert events[0]["type"] == "start" and events[-1]["type"] == "done"
    frames = [e for e in events if e["type"] == "frame"]
    assert len(frames) == 40
    assert [f["seq"] for f in frames] == list(range(40))
    assert [f["frame_index"] for f in frames] == events[0]["indices"]
    assert all(f["value"] == pytest.approx(truth[f["frame_index"]]) for f in frames)
    assert events[-1]["recognised"] == 40
    assert len(fake_gemini.calls) == math.ceil(40 / 7)
    assert "cropped around the scale's display" in fake_gemini.calls[0]["prompt"]


def test_ai_whole_frame_without_roi(client, uploaded, fake_gemini):
    meta, truth = uploaded
    events = _stream(client, meta["id"], {"samples": 5, "options": {"engine": "gemini"}})
    frames = [e for e in events if e["type"] == "frame"]
    assert len(frames) == 5 and all(f["value"] is not None for f in frames)
    assert "full video frame" in fake_gemini.calls[0]["prompt"]


def test_ai_prompt_carries_hints(client, uploaded, fake_gemini):
    meta, _ = uploaded
    opts = {"engine": "gemini", "decimals": 1, "min_value": 0, "max_value": 150, "allow_negative": False}
    _stream(client, meta["id"], {"roi": ROI, "samples": 3, "options": opts})
    prompt = fake_gemini.calls[0]["prompt"]
    assert "exactly 1 digit after the decimal point" in prompt
    assert "between 0 and 150" in prompt
    assert "never shows negative" in prompt


def test_ai_fatal_error_stops_job(client, uploaded, monkeypatch):
    meta, _ = uploaded
    monkeypatch.setattr(config, "GEMINI_API_KEY", "bad-key")

    def boom(parts, n, stop):
        raise ai.AIError("Gemini API error 400: API key not valid")

    monkeypatch.setitem(ai._PROVIDERS, "gemini", boom)
    events = _stream(client, meta["id"], {"roi": ROI, "samples": 10, "options": {"engine": "gemini"}})
    assert events[-1] == {"type": "error", "message": "Gemini API error 400: API key not valid"}


def test_ai_transient_error_flags_frames(client, uploaded, monkeypatch):
    meta, _ = uploaded
    monkeypatch.setattr(config, "GEMINI_API_KEY", "test-key")

    def overloaded(parts, n, stop):
        raise ai.AITransientError("Gemini API error 503: overloaded")

    monkeypatch.setitem(ai._PROVIDERS, "gemini", overloaded)
    events = _stream(client, meta["id"], {"roi": ROI, "samples": 4, "options": {"engine": "gemini"}})
    frames = [e for e in events if e["type"] == "frame"]
    assert events[-1]["type"] == "done"
    assert all(f["value"] is None and "model_error" in f["flags"] for f in frames)


def _inputs(*idx):
    import numpy as np

    return [ai.FrameInput(i, i / 25, np.zeros((4, 4, 3), np.uint8)) for i in idx]


def test_parse_reply_variants():
    frames = _inputs(10, 20, 30)
    raw = (
        "<think>the first display looks like {maybe 7}</think>\n"
        '{"readings": [{"frame": 30, "value": "", "certain": true},'
        ' {"frame": 10, "value": "72.40", "certain": true},'
        ' {"frame": 20, "value": "72.5", "certain": false}]}'
    )
    out = ai.parse_reply(raw, frames, "gemini")
    assert [o.text for o in out] == ["72.40", "72.5", ""]
    assert [o.confidence for o in out] == [0.95, 0.5, 0.0]

    # Frame numbers missing or wrong: fall back to position; short replies flag the rest.
    out = ai.parse_reply('[{"value": "1.0"}, {"value": "none"}]', frames, "gemini")
    assert [o.text for o in out] == ["1.0", "", ""]
    assert out[2].flags == ["model_skipped"]

    assert all(o.text == "" for o in ai.parse_reply("I can't see a display.", frames, "gemini"))


def test_model_image_crop_and_whole_frame():
    import numpy as np

    from app.schemas import ROI as ROIModel

    frame = np.zeros((720, 1280, 3), np.uint8)
    opts = OCROptions()
    # A small, wide display is enlarged until its long side hits the cap.
    crop = ai.model_image(frame, ROIModel(x=0.4, y=0.45, w=0.1, h=0.05), opts)
    assert crop.shape[1] == 1024 and crop.shape[0] > 200
    square = ai.model_image(frame, ROIModel(x=0.4, y=0.4, w=0.05, h=0.08), opts)
    assert min(square.shape[:2]) == 360
    rotated = ai.model_image(frame, ROIModel(x=0.4, y=0.45, w=0.1, h=0.05), OCROptions(rotate=90))
    assert rotated.shape[0] > rotated.shape[1]
    assert ai.model_image(frame, None, opts).shape == (720, 1280, 3)


def test_roi_lerp():
    from app.schemas import ROI as ROIModel

    a = ROIModel(x=0.1, y=0.1, w=0.2, h=0.1)
    b = ROIModel(x=0.3, y=0.1, w=0.2, h=0.1)
    mid = a.lerp(b, 0.5)
    assert mid.x == pytest.approx(0.2)
    assert a.lerp(b, 0.0).x == pytest.approx(a.x)
    assert a.lerp(b, 1.0).x == pytest.approx(b.x)
    assert a.lerp(b, 5.0).x == pytest.approx(b.x)  # clamps past 1
    assert a.lerp(b, -5.0).x == pytest.approx(a.x)  # clamps below 0


def test_password_gate(client, uploaded, monkeypatch):
    meta, _ = uploaded
    monkeypatch.setattr(config, "APP_PASSWORD", "s3cret")
    health = client.get("/api/health").json()  # stays open so the UI can ask for the password
    assert health["auth_required"] is True
    assert client.get("/api/auth").status_code == 401
    assert client.get("/api/auth", headers={"X-App-Password": "wrong"}).status_code == 401
    assert client.get("/api/auth", headers={"X-App-Password": "s3cret"}).status_code == 200
    frame = f"/api/videos/{meta['id']}/frames/0"
    assert client.get(frame).status_code == 401
    assert client.get(frame + "?key=s3cret").status_code == 200  # <img src> can't send headers
    # CORS preflights pass without the password, and 401s still carry CORS headers.
    origin = {"Origin": "http://localhost:5173"}
    pre = client.options("/api/auth", headers={**origin, "Access-Control-Request-Method": "GET",
                                               "Access-Control-Request-Headers": "x-app-password"})
    assert pre.status_code == 200
    denied = client.get("/api/auth", headers=origin)
    assert denied.status_code == 401 and denied.headers["access-control-allow-origin"] == origin["Origin"]


def test_public_server_blocks_disk_export(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PUBLIC", True)
    assert client.get("/api/health").json()["fs_access"] is False
    assert client.get("/api/fs/list").status_code == 403
    r = client.post("/api/export/csv", json={"rows": [], "directory": str(tmp_path)})
    assert r.status_code == 403


def test_csv_export(client, tmp_path):
    rows = [
        {"timestamp": 0.0, "frame_index": 0, "weight_value": 1.5, "confidence": 0.9},
        {"timestamp": 0.04, "frame_index": 1, "weight_value": None},
    ]
    r = client.post("/api/export/csv", json={"rows": rows, "directory": str(tmp_path), "filename": "out"})
    assert r.status_code == 200, r.text
    text = Path(r.json()["path"]).read_text()
    assert text.splitlines() == ["timestamp,frame_index,weight_value", "0.0000,0,1.5", "0.0400,1,"]


@pytest.mark.parametrize(
    "text,opts,expected",
    [
        ("72.4", {}, 72.4),
        ("72.4kg", {}, 72.4),
        ("12.5 lb", {}, 12.5),
        ("O7,2", {}, 7.2),
        ("724", {"decimals": 1}, 72.4),
        ("-0.5", {"allow_negative": False}, 0.5),
        ("abc", {}, None),
    ],
)
def test_parse(text, opts, expected):
    value, _ = parse_value(text, OCROptions(**opts))
    assert value == (pytest.approx(expected) if expected is not None else None)
