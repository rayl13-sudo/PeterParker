"""Profile pictures: a random two-color silhouette by default, or an uploaded photo."""

import base64
import binascii
import colorsys
import random
import re

# Uploaded photos arrive as small data URLs (the browser crops and resizes them first).
IMAGE_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$")
MAX_IMAGE_CHARS = 400_000  # ~300 KB of image data


def _hex(hue: float, saturation: float, lightness: float) -> str:
    r, g, b = colorsys.hls_to_rgb(hue / 360, lightness, saturation)
    return f"#{round(r * 255):02x}{round(g * 255):02x}{round(b * 255):02x}"


def random_colors(rng: random.Random | None = None) -> tuple[str, str]:
    """A light background and a darker silhouette in a clearly different hue."""
    rng = rng or random.SystemRandom()
    bg_hue = rng.uniform(0, 360)
    fg_hue = (bg_hue + rng.uniform(120, 240)) % 360  # at least a third of the wheel away
    return _hex(bg_hue, 0.70, 0.84), _hex(fg_hue, 0.60, 0.38)


def validate_image(data_url: str) -> str:
    if len(data_url) > MAX_IMAGE_CHARS:
        raise ValueError("That picture is too large. Try a smaller image.")
    match = IMAGE_RE.match(data_url)
    if not match:
        raise ValueError("Upload a PNG, JPEG or WebP image.")
    try:
        base64.b64decode(match.group(2), validate=True)
    except binascii.Error as exc:
        raise ValueError("That picture couldn't be read.") from exc
    return data_url
