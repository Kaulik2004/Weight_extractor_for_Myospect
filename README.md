# Weight Extractor

A local web app that reads weighing-scale displays out of video recordings.
Upload a video, optionally draw a box over the scale's display, pick how many
frames to sample, and an AI vision model (Gemini, Claude, OpenAI or Groq) reads
the weight in each sampled frame. Results stream live into an editable table
and a weight-vs-time chart, and can be exported as CSV to any folder.

```
frontend/  React 19 + Vite + TypeScript + Tailwind v4 + Framer Motion + Chart.js
backend/   FastAPI + OpenCV, AI vision engines (Gemini, Claude, OpenAI, Groq) + optional EasyOCR
```

## Quick start (Windows)

Needs Python 3.10+ and Node 20+.

1. Copy `backend\.env.example` to `backend\.env` and paste in at least one API
   key (see [Engines](#engines)).
2. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
   ```

This creates `backend\.venv`, installs packages if needed, and opens two
windows: the API on http://127.0.0.1:8000 (docs at `/docs`) and the UI on
http://localhost:5173.

If `backend\.venv` already exists from an older version, install the new
dependencies once: `backend\.venv\Scripts\python -m pip install -r backend\requirements.txt`.

## Manual start (any OS)

```bash
# 1. Backend
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev          # http://localhost:5173, proxies /api to port 8000
```

### Single-port production mode

```bash
cd frontend && npm run build          # writes frontend/dist
cd ../backend && uvicorn app.main:app --host 127.0.0.1 --port 8000
```

FastAPI serves the built UI at http://127.0.0.1:8000. `start-prod.ps1` does both steps.

## Deploy online (Vercel + Render)

The frontend is a static site on **Vercel**. The backend runs unchanged as a
Docker container on **Render** (`render.yaml` + `backend/Dockerfile`). The
browser calls Render directly, because Vercel's proxy cuts requests off after
120 s and a long extraction streams for longer.

1. **Push this folder to a GitHub repository** (private is fine). `.env`,
   uploads, `.venv` and `node_modules` are gitignored.
2. **Backend on Render:** *New → Blueprint*, pick the repo. Render reads
   `render.yaml` and asks for:
   - `APP_PASSWORD`: required. Everyone who opens the site must type it, since
     requests spend your AI quota. The server refuses to start without it.
   - the API keys you use (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, ...); leave the rest empty.

   Note the service URL, e.g. `https://weight-extractor-api.onrender.com`.
3. **Frontend on Vercel:** *Add New → Project*, import the same repo, set
   **Root Directory** to `frontend`, and add the environment variable
   `VITE_API_BASE` = the Render URL (no trailing slash). Deploy.
4. If the Vercel project isn't named `weight-extractor`, change
   `WX_CORS_ORIGIN_REGEX` on Render to match its URLs, or set `WX_CORS_ORIGINS`
   to the exact Vercel URL.

What differs from running locally:
- **Free Render instances sleep** after about 15 minutes idle; the first request
  then takes about a minute (the page keeps retrying). Their disk is temporary, so
  an uploaded video is lost when the instance sleeps or redeploys; just upload it
  again.
- **CSV export:** *Download* and *Local folder* work; *Path* (writing to the
  server's disk) is hidden.
- **EasyOCR** isn't installed in the container (PyTorch is too large for the
  free tier); the AI engines are.

## Engines

| Engine | Enable with (in `backend/.env`) | Default model | Notes |
|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` ([get one](https://aistudio.google.com/apikey), free tier available) | `gemini-3.8-flash` | Recommended default. |
| `claude` | `ANTHROPIC_API_KEY` ([get one](https://platform.claude.com/settings/keys)) | `claude-opus-5-5` | Strongest reader. If a safety filter ever declines a request, the API automatically retries it on Anthropic's recommended fallback model (`fallbacks: "default"`). |
| `openai` | `OPENAI_API_KEY` ([get one](https://platform.openai.com/api-keys)) | `gpt-6.1-sol` | ChatGPT models via the Responses API. |
| `groq` | `GROQ_API_KEY` | `qwen/qwen3.8-27b` | Fast and cheap, but clearly less accurate than the three above. Max 3 images per request. |
| `easyocr` | `pip install -r requirements-easyocr.txt` (~1–2 GB) | – | Local, no key, no network. Needs an ROI. |

Change a model with `GEMINI_MODEL`, `CLAUDE_MODEL`, `OPENAI_MODEL` or
`GROQ_MODEL`. The header shows which engines the backend detected. Restart the
backend after editing `.env`.

### How the AI engines read a video

Uploading a clip to Gemini or Claude in the browser works well because a strong
vision model sees the display in colour and sees many frames of the same
recording together. The AI engines here reproduce that:

1. **Colour images, no thresholding.** Each sampled frame is sent either as the
   ROI plus a 15% margin (small displays are enlarged so thin segments and the
   decimal point survive), or, with no ROI drawn, as the whole frame.
2. **Big chronological batches.** Frames go out `AI_BATCH_SIZE` at a time (default
   24; 3 for Groq), each preceded by a label such as
   `Image 3/24 - frame 150, t = 6.000 s`. `AI_CONCURRENCY` batches (default 4) run
   in parallel, and results still stream back in frame order.
3. **A detailed prompt** (`build_prompt` in `backend/app/ocr/ai.py`). It covers
   seven-segment confusions (1/7, 0/8, 5/6), faint "ghost" segments, the easily
   missed decimal point, which numbers to ignore (units, tare, clocks), and how to
   use neighbouring frames only for genuinely ambiguous digits. It also passes on
   your *Decimals*, *Min/Max* and *Allow negative* settings.
4. **JSON replies keyed by frame number**, so every reading lands on the right
   row. The model marks each reading `certain` or not; unsure readings get 50%
   confidence and show up under *Needs review*.

A bad API key or model name stops the job with the provider's error message. A
rate limit or outage that outlasts the retries only affects that batch: its
frames come back empty and flagged *AI request failed*.

**Privacy:** the AI engines upload the sampled frames to the provider. Use
`easyocr` for footage that must stay on this machine. `backend/.env` is
gitignored, so never commit an API key.

## Workflow

1. **Upload** an `.mp4`, `.avi` or `.mov`. If the browser cannot play the codec
   (common for AVI), the stage switches to frames decoded by the backend. You can
   also toggle that manually to see exactly what OpenCV sees.
2. **Draw the ROI (optional for AI engines)** by dragging over the display. Drag
   inside it to move and drag corners to resize. Without an ROI the AI reads the
   whole frame; with one it gets a closer, higher-resolution view of the digits,
   which helps for small or distant displays.
   - **Handheld footage that zooms or pans:** a single fixed box only works if the
     camera holds still. If it doesn't, use the **Editing: Start box / End box**
     toggle under the video. Draw the box at the start frame, switch to *End box*
     (it jumps you to the end frame), draw where the display is there, and the app
     blends the box frame-by-frame across the sampling range. The other box shows
     as a dashed reference while you edit one of them.
3. **Pick the engine and hints.** Set *Decimals* if you know how many digits
   follow the decimal point, and a plausible min/max range. **Test on frame** shows
   the exact image the model receives and what it read.
4. **Sample.** Choose either *N total frames* or *samples per second*
   (interval = FPS / rate). `[` and `]` set the start and end to the current
   frame. The readout shows `Total Extracted Datapoints = N`.
5. **Extract.** Rows stream in live, batch by batch. The live feed shows the
   latest image sent to the model. Abort at any time.
6. **Review.** Click a weight to edit it. Enter saves and moves to the next row,
   Escape cancels, and the undo icon reverts to the model's value. The *Needs
   review* filter lists unsure and failed frames. Clicking a row or chart point
   seeks the video to that frame.
7. **Export CSV.**
   - *Download* saves through the browser.
   - *Local folder* uses the File System Access API (Chrome/Edge) to write into a
     folder you pick; the choice is remembered.
   - *Path* has the local backend write the file to any folder, with a built-in
     folder browser. It works in every browser.

CSV columns: `timestamp,frame_index,weight_value`. Enable the toggle to add
`unit,confidence,edited`.

The kg/lbs switch labels the data. It does not convert values.

## API

All routes are under `/api`. Interactive docs are at `/docs`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Status plus which engines are configured |
| POST | `/videos` | Multipart upload (`file`). Returns fps, frame count, size |
| GET | `/videos/{id}` | Video metadata |
| DELETE | `/videos/{id}` | Remove an upload |
| GET | `/videos/{id}/file` | Raw video with range support |
| GET | `/videos/{id}/frames/{index}?max_width=` | One decoded frame as JPEG |
| POST | `/videos/{id}/ocr-test` | Read one frame; returns the reading and `input_image` (what the engine saw) |
| POST | `/videos/{id}/extract` | Run a job. Streams NDJSON events |
| POST | `/export/csv` | Write a CSV to a folder on this machine (loopback clients only) |
| GET | `/fs/list?path=` | List sub-folders for the folder browser (loopback clients only) |

`POST /extract` body (`roi` may be omitted or `null` for AI engines = whole frame):

```json
{
  "roi": { "x": 0.33, "y": 0.39, "w": 0.34, "h": 0.21 },
  "samples": 100,
  "start_frame": 0,
  "end_frame": 299,
  "options": {
    "engine": "gemini",
    "rotate": 0,
    "decimals": null,
    "min_value": null,
    "max_value": null,
    "allow_negative": true
  }
}
```

`options` also accepts `polarity`, `threshold`, `upscale` and `blur`, which
only affect EasyOCR. The ROI is normalised to 0–1 of the frame, so it does not
depend on screen size. The response is one JSON object per line:

```
{"type":"start","total":100,"indices":[0,3,6,...],"fps":30.0}
{"type":"frame","seq":0,"frame_index":0,"timestamp":0.0,"value":72.4,"confidence":0.95,"text":"72.4","boxes":[],"flags":[],"preview":"data:image/jpeg;base64,..."}
...
{"type":"done","total":100,"recognised":98,"elapsed_s":31.5,"fps_processed":3.2}
```

Closing the connection cancels the job. Frame indices are spread evenly over
`[start_frame, end_frame]`. Short forward gaps are read sequentially rather than
by seeking, which is faster and frame-accurate.

### Pipeline

1. Decode the sampled frames with OpenCV.
2. **AI engines:** crop the ROI with a margin (or keep the whole frame), rotate,
   and resize, then send batches to the provider as described above.
   **EasyOCR:** crop, upscale, apply CLAHE, blur, and threshold, then run EasyOCR.
3. Parse the number. Unit text is stripped, look-alike letters are mapped to
   digits, the decimal count can be forced, and range checks add flags.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest -q
```

The tests render a synthetic scale video with `tools/make_demo_video.py`,
upload it, and run extraction against a fake AI provider that answers from the
ground truth. That covers batching, ordering, reply parsing, whole-frame mode
and error handling without API keys or network. To create a demo video to try
in the UI:

```bash
python tools/make_demo_video.py demo_scale.mp4 --seconds 10
```

Browsers cannot play this file's `mp4v` codec, so the stage uses server frames.
Its display ROI is roughly x=0.33, y=0.39, w=0.34, h=0.21.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-3.8-flash` | Gemini engine |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | – / `claude-opus-5-5` | Claude engine |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-6.1-sol` | OpenAI engine |
| `GROQ_API_KEY` / `GROQ_MODEL` | – / `qwen/qwen3.8-27b` | Groq engine (model must accept images) |
| `AI_BATCH_SIZE` | `24` | Frames per request for Gemini, Claude and OpenAI |
| `AI_CONCURRENCY` | `4` | Requests in parallel; lower it if you hit 429 rate limits |
| `GROQ_BATCH_SIZE` | `3` | Frames per Groq request (its per-request image cap) |
| `WX_STORAGE_DIR` | `backend/storage` | Where uploads and default exports go |
| `WX_MAX_SAMPLES` | `20000` | Upper limit for N |
| `WX_CORS_ORIGINS` | `http://localhost:5173,...` | Allowed dev origins |
| `WX_CORS_ORIGIN_REGEX` | – | Extra allowed origins as a regex (e.g. all Vercel URLs of the frontend) |
| `APP_PASSWORD` | – | Password required on every `/api` route except `/api/health` |
| `WX_PUBLIC` | – (`1` in the Docker image) | Public server: requires `APP_PASSWORD` and disables disk export |
| `VITE_API_BASE` | same origin | Frontend: API base URL if not proxied |

All of these can go in `backend/.env`. Uploads are kept in
`backend/storage/uploads` until deleted. Replacing a video in the UI deletes the
previous upload.

## Security notes

Locally, the file-system routes only accept requests from `127.0.0.1`/`::1`.
Keep a local server bound to `127.0.0.1`. When hosted, `APP_PASSWORD` protects
every route except `/api/health`, and the file-system routes are disabled
entirely (`WX_PUBLIC=1`).

The AI engines are the exception to "stays on your machine": sampled frames are
uploaded to the chosen provider. Keep API keys in `backend/.env`, which is
already gitignored.
