"""Turn raw OCR text into a numeric weight reading."""
from __future__ import annotations

import re
from typing import Optional

from ..schemas import OCROptions

# Frequent confusions for digit-only displays.
_CHAR_MAP = str.maketrans(
    {
        "O": "0", "o": "0", "D": "0", "Q": "0",
        "I": "1", "l": "1", "|": "1", "!": "1",
        "Z": "2",
        "S": "5",
        "B": "8",
        ",": ".",
        "_": "-", "~": "-",
    }
)

# Unit labels printed on the display are removed before mapping, so that
# "12.5 lb" does not become "12.516" and "80kg" does not gain a digit.
_UNIT_RE = re.compile(r"(?i)(kgs?|lbs?|oz|g)(?![a-z])")

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def normalise_text(text: str) -> str:
    text = _UNIT_RE.sub(" ", text or "")
    return re.sub(r"\s+", "", text.translate(_CHAR_MAP))


def parse_value(text: str, opts: OCROptions) -> tuple[Optional[float], list[str]]:
    """Return (value, flags). Flags describe why a reading may be unreliable."""
    flags: list[str] = []
    cleaned = normalise_text(text)
    matches = _NUMBER_RE.findall(cleaned)
    if not matches:
        return None, ["no_digits"]

    # The display's main reading is the longest numeric run.
    token = max(matches, key=lambda m: len(m.replace("-", "").replace(".", "")))
    if len(matches) > 1:
        flags.append("extra_text")

    negative = token.startswith("-")
    if negative and not opts.allow_negative:
        negative = False
        flags.append("sign_dropped")

    if opts.decimals is not None:
        digits = token.replace("-", "").replace(".", "")
        value = int(digits) / (10 ** opts.decimals)
    else:
        value = float(token.replace("-", ""))
    if negative:
        value = -value

    if opts.min_value is not None and value < opts.min_value:
        flags.append("out_of_range")
    if opts.max_value is not None and value > opts.max_value:
        flags.append("out_of_range")
    return value, flags
