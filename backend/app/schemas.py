"""Pydantic request / response models."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .config import MAX_SAMPLES

EngineName = Literal["gemini", "claude", "openai", "groq", "easyocr"]
# Vision-LLM engines: they read the display like a person would, and can work
# on the whole frame when no ROI is drawn.
AI_ENGINES = ("gemini", "claude", "openai", "groq")


class VideoMeta(BaseModel):
    id: str
    filename: str
    fps: float
    frame_count: int
    duration: float
    width: int
    height: int
    size_bytes: int


class ROI(BaseModel):
    """Region of interest in *normalised* coordinates (0..1 of the frame size)."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def _inside(self) -> "ROI":
        if self.x + self.w > 1.0001 or self.y + self.h > 1.0001:
            raise ValueError("ROI extends outside the frame")
        return self

    def to_pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        x0 = max(0, int(round(self.x * width)))
        y0 = max(0, int(round(self.y * height)))
        x1 = min(width, max(int(round((self.x + self.w) * width)), x0 + 2))
        y1 = min(height, max(int(round((self.y + self.h) * height)), y0 + 2))
        return x0, y0, x1 - x0, y1 - y0

    def lerp(self, other: "ROI", t: float) -> "ROI":
        """Linearly interpolate toward `other` (t=0 -> self, t=1 -> other).

        Used to track a display that drifts or changes size across a video
        (camera zoom/pan) by blending between a box drawn at the start of the
        sampling range and one drawn at the end.
        """
        t = max(0.0, min(1.0, t))
        return ROI(
            x=self.x + (other.x - self.x) * t,
            y=self.y + (other.y - self.y) * t,
            w=self.w + (other.w - self.w) * t,
            h=self.h + (other.h - self.h) * t,
        )


class OCROptions(BaseModel):
    engine: EngineName = "gemini"
    # Preprocessing (EasyOCR only). Polarity: LCD = dark digits on light, LED = light on dark.
    polarity: Literal["auto", "dark_on_light", "light_on_dark"] = "auto"
    threshold: Literal["otsu", "adaptive", "none"] = "otsu"
    upscale: float = Field(default=2.0, ge=1.0, le=6.0)
    blur: int = Field(default=3, ge=0, le=15)
    rotate: Literal[0, 90, 180, 270] = 0
    # Parsing
    decimals: Optional[int] = Field(
        default=None,
        ge=0,
        le=4,
        description="Force N decimal places (repairs a missed decimal point). None = as read.",
    )
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    allow_negative: bool = True


class ExtractRequest(BaseModel):
    roi: Optional[ROI] = Field(
        default=None,
        description="Box around the display. Optional for AI engines (None = whole frame).",
    )
    roi_end: Optional[ROI] = Field(
        default=None,
        description=(
            "Optional second box, positioned at end_frame. When set, the ROI used "
            "for each sampled frame is linearly interpolated between `roi` (at "
            "start_frame) and `roi_end` (at end_frame), so a display that drifts "
            "or zooms across a handheld recording stays tracked."
        ),
    )
    samples: int = Field(ge=1, description="Total number of frames to sample (N)")
    start_frame: int = Field(default=0, ge=0)
    end_frame: Optional[int] = Field(default=None, ge=0)
    options: OCROptions = OCROptions()
    include_previews: bool = True

    @field_validator("samples")
    @classmethod
    def _cap(cls, v: int) -> int:
        if v > MAX_SAMPLES:
            raise ValueError(f"samples must be <= {MAX_SAMPLES}")
        return v


class TestRequest(BaseModel):
    roi: Optional[ROI] = None
    frame_index: int = Field(ge=0)
    options: OCROptions = OCROptions()


class CsvRow(BaseModel):
    timestamp: float
    frame_index: int
    weight_value: Optional[float]
    confidence: Optional[float] = None
    edited: bool = False


class CsvExportRequest(BaseModel):
    rows: list[CsvRow]
    directory: str
    filename: str = "weights.csv"
    unit: str = "kg"
    include_extras: bool = False
    overwrite: bool = False
