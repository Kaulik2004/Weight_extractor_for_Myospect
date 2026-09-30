"""Generate a synthetic weighing-scale video for testing the pipeline.

Usage:
    python tools/make_demo_video.py [out.mp4] [--seconds 10] [--fps 30] [--lcd]

A seven-segment display shows a weight that ramps up, oscillates and settles;
the true value for each frame is written next to the video as *_truth.csv.
"""
from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

import cv2
import numpy as np

SEGMENTS = {
    "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
    "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg", "-": "g",
}


def draw_digit(img, ch, x, y, w, h, t, on, off):
    """Draw one seven-segment glyph with top-left (x, y)."""
    half = h // 2
    segs = {
        "a": [(x + t, y), (x + w - t, y), (x + w - 2 * t, y + t), (x + 2 * t, y + t)],
        "d": [(x + 2 * t, y + h - t), (x + w - 2 * t, y + h - t), (x + w - t, y + h), (x + t, y + h)],
        "g": [(x + t, y + half), (x + 2 * t, y + half - t // 2), (x + w - 2 * t, y + half - t // 2),
              (x + w - t, y + half), (x + w - 2 * t, y + half + t // 2), (x + 2 * t, y + half + t // 2)],
        "f": [(x, y + t), (x + t, y + 2 * t), (x + t, y + half - t), (x, y + half - t // 2)],
        "e": [(x, y + half + t // 2), (x + t, y + half + t), (x + t, y + h - 2 * t), (x, y + h - t)],
        "b": [(x + w, y + t), (x + w, y + half - t // 2), (x + w - t, y + half - t), (x + w - t, y + 2 * t)],
        "c": [(x + w, y + half + t // 2), (x + w, y + h - t), (x + w - t, y + h - 2 * t), (x + w - t, y + half + t)],
    }
    lit = SEGMENTS.get(ch, "")
    for name, pts in segs.items():
        cv2.fillPoly(img, [np.array(pts, np.int32)], on if name in lit else off, cv2.LINE_AA)


def render(value: float, size=(1280, 720), lcd=False, noise=0.0, rng=None) -> np.ndarray:
    W, H = size
    frame = np.full((H, W, 3), (38, 34, 30), np.uint8)
    # Scale body
    cv2.rectangle(frame, (340, 180), (940, 560), (70, 66, 62), -1)
    # Display window
    bg, on, off = ((150, 190, 170), (35, 40, 30), (140, 178, 160)) if lcd else ((20, 15, 15), (80, 80, 255), (32, 26, 30))
    x0, y0, dw, dh = 420, 280, 440, 150
    cv2.rectangle(frame, (x0, y0), (x0 + dw, y0 + dh), bg, -1)
    text = f"{value:5.1f}"  # e.g. " 72.4"
    dx, dy, w, h, t = x0 + 30, y0 + 25, 62, 100, 12
    pos = dx
    for ch in text:
        if ch == ".":
            cv2.circle(frame, (pos - 8, dy + h - 6), 7, on, -1, cv2.LINE_AA)
            continue
        if ch != " ":
            draw_digit(frame, ch, pos, dy, w, h, t, on, off)
        pos += w + 22
    cv2.putText(frame, "kg", (x0 + dw - 55, y0 + dh - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.8, on, 2, cv2.LINE_AA)
    if noise and rng is not None:
        frame = np.clip(frame.astype(np.int16) + rng.normal(0, noise, frame.shape), 0, 255).astype(np.uint8)
    return frame


def weight_at(t: float, seconds: float) -> float:
    target = 72.4
    ramp = min(1.0, t / (seconds * 0.3))
    wobble = 3.5 * math.exp(-t / 2.0) * math.sin(6 * t)
    return round(target * ramp + wobble * ramp, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="demo_scale.mp4")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--lcd", action="store_true", help="dark digits on a light LCD")
    ap.add_argument("--noise", type=float, default=6.0)
    args = ap.parse_args()

    out = Path(args.out)
    rng = np.random.default_rng(0)
    writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), args.fps, (1280, 720))
    n = int(args.seconds * args.fps)
    with open(out.with_name(out.stem + "_truth.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["frame_index", "timestamp", "weight_value"])
        for i in range(n):
            t = i / args.fps
            v = weight_at(t, args.seconds)
            writer.write(render(v, lcd=args.lcd, noise=args.noise, rng=rng))
            w.writerow([i, f"{t:.4f}", v])
    writer.release()
    print(f"wrote {out} ({n} frames); display ROI approx x=0.328 y=0.389 w=0.344 h=0.208")


if __name__ == "__main__":
    main()
