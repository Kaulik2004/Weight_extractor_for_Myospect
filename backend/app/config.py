"""Runtime configuration, overridable through environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE per line) so secrets like GROQ_API_KEY
    don't have to be exported manually or hardcoded in source."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(BASE_DIR / ".env")

STORAGE_DIR = Path(os.getenv("WX_STORAGE_DIR", BASE_DIR / "storage")).resolve()
UPLOAD_DIR = STORAGE_DIR / "uploads"
EXPORT_DIR = STORAGE_DIR / "exports"

# Built frontend, served by FastAPI in production mode when present.
FRONTEND_DIST = Path(
    os.getenv("WX_FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist")
).resolve()

MAX_SAMPLES = int(os.getenv("WX_MAX_SAMPLES", "20000"))
ALLOWED_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".webm"}

# --- AI vision engines (each is enabled by setting its API key in backend/.env) ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-6.1-sol")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "qwen/qwen3.8-27b")
# Groq's vision models cap images per request (3 for the default model).
GROQ_BATCH_SIZE = int(os.getenv("GROQ_BATCH_SIZE", "3"))

# Frames per request for Gemini / Claude / OpenAI. Bigger batches give the
# model more neighbouring frames to cross-check against (like uploading the
# whole clip in a chat); all three accept far more images than this.
AI_BATCH_SIZE = int(os.getenv("AI_BATCH_SIZE", "24"))
# Batches sent in parallel. Lower it if you hit rate limits (429s).
AI_CONCURRENCY = int(os.getenv("AI_CONCURRENCY", "4"))

CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "WX_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if o.strip()
]
# Extra allowed origins as a regex, e.g. every Vercel URL of the frontend project.
CORS_ORIGIN_REGEX = os.getenv("WX_CORS_ORIGIN_REGEX") or None

# Shared password for every /api route except /api/health. Required when the
# server is reachable from the internet (WX_PUBLIC=1, set by the Dockerfile),
# since anyone with the URL could otherwise spend your AI API quota.
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
PUBLIC = os.getenv("WX_PUBLIC", "") == "1"
if PUBLIC and not APP_PASSWORD:
    raise RuntimeError("WX_PUBLIC=1 but APP_PASSWORD is not set: refusing to start without a password")

for _d in (UPLOAD_DIR, EXPORT_DIR):
    _d.mkdir(parents=True, exist_ok=True)
