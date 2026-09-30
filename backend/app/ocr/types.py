from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Detection:
    """One recognised glyph or word, box in *processed image* pixels."""

    x: int
    y: int
    w: int
    h: int
    text: str
    conf: float  # 0..1


@dataclass
class EngineOutput:
    text: str
    confidence: float  # 0..1
    detections: list[Detection] = field(default_factory=list)
    engine: str = ""
    flags: list[str] = field(default_factory=list)  # engine-level problems, e.g. "model_error"


@dataclass
class OcrResult:
    text: str
    value: Optional[float]
    confidence: float
    engine: str
    detections: list[Detection]
    flags: list[str]
