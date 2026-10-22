"""Input-size limits for ``/segment``: data URL length, pixel count and body size.

Image dimensions are read from the PNG/JPEG header with the stdlib so that an
oversized image (a small file declaring e.g. 30000x30000 pixels) is rejected
before OpenCV allocates a full-resolution buffer. This module must not import
cv2: ``main`` uses it to configure OpenCV before cv2 is first imported.
"""

import struct
from typing import Optional, Tuple

from env_config import env_int

MAX_DATA_URL_CHARS_ENV = "SEGMENT_MAX_DATA_URL_CHARS"
MAX_PIXELS_ENV = "SEGMENT_MAX_PIXELS"
MAX_BODY_BYTES_ENV = "SEGMENT_MAX_BODY_BYTES"
OPENCV_MAX_PIXELS_ENV = "OPENCV_IO_MAX_IMAGE_PIXELS"

# ~12M base64 chars decode to ~9 MB, just above the Next.js route's 8 MB image cap.
DEFAULT_MAX_DATA_URL_CHARS = 12_000_000
DEFAULT_MAX_PIXELS = 40_000_000
# Room for the JSON envelope around the data URL (clicks, roi, meta.osmFootprint).
BODY_HEADROOM_BYTES = 4_000_000
# OpenCV's own default ceiling (2^30 pixels); limits above it would be ignored.
PIXEL_HARD_MAX = 1 << 30
SIZE_HARD_MAX = 1 << 31

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SOI = b"\xff\xd8"
_JPEG_EOI = 0xD9
_JPEG_SOS = 0xDA
# Start-of-frame markers carrying the frame size (DHT 0xC4, JPG 0xC8, DAC 0xCC excluded).
_JPEG_SOF_MARKERS = frozenset(
    (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF)
)
# Markers without a length field: TEM, RST0..RST7 and SOI.
_JPEG_STANDALONE_MARKERS = frozenset((0x01, *range(0xD0, 0xD9)))
# Bounds the header walk so a crafted marker stream cannot burn CPU.
_JPEG_MAX_STEPS = 4096


class ImageTooLarge(Exception):
    """The input exceeds a configured size limit (mapped to HTTP 413)."""


def max_data_url_chars() -> int:
    return env_int(MAX_DATA_URL_CHARS_ENV, DEFAULT_MAX_DATA_URL_CHARS, 1, SIZE_HARD_MAX)


def max_pixels() -> int:
    return env_int(MAX_PIXELS_ENV, DEFAULT_MAX_PIXELS, 1, PIXEL_HARD_MAX)


def max_body_bytes() -> int:
    default = max_data_url_chars() + BODY_HEADROOM_BYTES
    return env_int(MAX_BODY_BYTES_ENV, default, 1, SIZE_HARD_MAX)


def check_data_url_length(data_url: str) -> None:
    limit = max_data_url_chars()
    if len(data_url) > limit:
        raise ImageTooLarge(f"data URL is {len(data_url)} chars; limit is {limit}")


def check_pixel_count(width: int, height: int) -> None:
    limit = max_pixels()
    if width * height > limit:
        raise ImageTooLarge(f"image is {width}x{height} pixels; limit is {limit}")


def _png_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    # Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
    if len(data) < 24 or not data.startswith(PNG_SIGNATURE):
        return None
    if data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def _jpeg_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    if not data.startswith(_JPEG_SOI):
        return None
    n = len(data)
    i = len(_JPEG_SOI)
    for _ in range(_JPEG_MAX_STEPS):
        if i + 2 > n or data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte before the real marker
            i += 1
            continue
        i += 2
        if marker in _JPEG_STANDALONE_MARKERS:
            continue
        if marker in (_JPEG_EOI, _JPEG_SOS):  # image data reached without a frame
            return None
        if i + 2 > n:
            return None
        (segment_len,) = struct.unpack(">H", data[i : i + 2])
        if segment_len < 2:
            return None
        if marker in _JPEG_SOF_MARKERS:
            # Segment: length (2), precision (1), height (2), width (2), ...
            if i + 7 > n:
                return None
            height, width = struct.unpack(">HH", data[i + 3 : i + 7])
            return width, height
        i += segment_len
    return None


def image_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) from a PNG IHDR or JPEG SOF header; None if unknown.

    Zero dimensions (e.g. a JPEG whose height is deferred to a DNL marker) are
    reported as unknown so the caller falls back to a post-decode check.
    """
    dims = _png_dimensions(data) or _jpeg_dimensions(data)
    if dims is None or dims[0] == 0 or dims[1] == 0:
        return None
    return dims
