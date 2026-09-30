"""ROI cropping and image conditioning for the EasyOCR engine.

The AI engines skip all of this: they get a colour image (see ``ai.model_image``).
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ..schemas import ROI, OCROptions

_ROTATIONS = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


@dataclass
class Prepared:
    crop: np.ndarray  # BGR crop after rotation, original resolution
    gray: np.ndarray  # upscaled, blurred grayscale
    binary: np.ndarray  # upscaled, digits WHITE (255) on black (0)
    scale: float  # processed pixels per crop pixel

    @property
    def dark_on_light(self) -> np.ndarray:
        """Black digits on white: the layout EasyOCR prefers."""
        return cv2.bitwise_not(self.binary)


def crop_roi(frame: np.ndarray, roi: ROI) -> np.ndarray:
    h, w = frame.shape[:2]
    x, y, cw, ch = roi.to_pixels(w, h)
    return frame[y : y + ch, x : x + cw]


def prepare(frame: np.ndarray, roi: ROI, opts: OCROptions) -> Prepared:
    crop = crop_roi(frame, roi)
    if opts.rotate in _ROTATIONS:
        crop = cv2.rotate(crop, _ROTATIONS[opts.rotate])

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop.copy()

    # Upscale small displays so strokes are several pixels thick. Very large
    # crops are left alone to keep processing fast.
    scale = float(opts.upscale)
    if gray.shape[0] * scale > 600:
        scale = max(1.0, 600 / gray.shape[0])
    if scale != 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # Local contrast normalisation copes with glare and uneven backlight.
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(gray)

    if opts.blur > 0:
        k = opts.blur | 1  # kernel must be odd
        gray = cv2.GaussianBlur(gray, (k, k), 0)

    binary = _threshold(gray, opts.threshold)
    binary = _normalise_polarity(binary, opts.polarity)
    return Prepared(crop=crop, gray=gray, binary=binary, scale=scale)


def _threshold(gray: np.ndarray, mode: str) -> np.ndarray:
    if mode == "adaptive":
        block = max(11, (min(gray.shape[:2]) // 4) | 1)
        return cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 5
        )
    # "none" still builds a binary image (used for polarity detection and the
    # test preview); EasyOCR then reads Prepared.gray instead.
    _, out = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return out


def _normalise_polarity(binary: np.ndarray, polarity: str) -> np.ndarray:
    """Return an image where the digits are white."""
    if polarity == "dark_on_light":
        return cv2.bitwise_not(binary)
    if polarity == "light_on_dark":
        return binary
    # Auto: look at the border ring. Background dominates the edge of a
    # well-drawn ROI, so the border colour tells us which side is background.
    h, w = binary.shape[:2]
    b = max(1, min(h, w) // 10)
    ring = np.concatenate(
        [binary[:b].ravel(), binary[-b:].ravel(), binary[:, :b].ravel(), binary[:, -b:].ravel()]
    )
    return cv2.bitwise_not(binary) if ring.mean() > 127 else binary
