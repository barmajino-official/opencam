"""High-performance OpenCV annotation for the re-broadcast track.

Rules of thumb applied here, because this runs on *every* egress frame:
  * No per-frame allocations that can be hoisted (colour LUT is cached).
  * `cv2.rectangle` / `cv2.putText` only — no PIL, no alpha compositing except
    one cheap ROI blend for label plates.
  * All geometry is integer-clamped once, up front.
"""

from __future__ import annotations

import hashlib
from typing import Any, Iterable

import cv2
import numpy as np

FONT = cv2.FONT_HERSHEY_SIMPLEX

# Fixed accents for the semantic layers; objects get a stable per-label colour.
COLOR_FACE_KNOWN = (120, 255, 120)
COLOR_FACE_UNKNOWN = (110, 190, 255)
COLOR_TEXT_REGION = (255, 200, 90)
COLOR_HUD_BG = (24, 20, 18)
COLOR_HUD_FG = (235, 240, 245)

_COLOR_CACHE: dict[str, tuple[int, int, int]] = {}


def label_color(label: str) -> tuple[int, int, int]:
    """Deterministic, readable BGR colour per class label."""
    cached = _COLOR_CACHE.get(label)
    if cached is not None:
        return cached

    digest = hashlib.md5(label.encode("utf-8")).digest()
    hue = digest[0] % 180
    pixel = np.uint8([[[hue, 190, 245]]])
    bgr = cv2.cvtColor(pixel, cv2.COLOR_HSV2BGR)[0][0]
    color = (int(bgr[0]), int(bgr[1]), int(bgr[2]))
    _COLOR_CACHE[label] = color
    return color


def _clamp_box(box: Iterable[float], width: int, height: int) -> tuple[int, int, int, int] | None:
    x, y, w, h = (float(v) for v in box)
    x1 = int(max(0, min(width - 1, x)))
    y1 = int(max(0, min(height - 1, y)))
    x2 = int(max(0, min(width - 1, x + w)))
    y2 = int(max(0, min(height - 1, y + h)))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    return x1, y1, x2, y2


def _draw_plate(
    image: np.ndarray,
    text: str,
    origin: tuple[int, int],
    color: tuple[int, int, int],
    *,
    scale: float = 0.45,
    thickness: int = 1,
) -> None:
    """Filled label plate with contrast-safe text, clipped to the frame."""
    height, width = image.shape[:2]
    (text_w, text_h), baseline = cv2.getTextSize(text, FONT, scale, thickness)
    pad_x, pad_y = 5, 4

    x, y = origin
    plate_h = text_h + baseline + pad_y * 2
    plate_w = text_w + pad_x * 2

    top = y - plate_h
    if top < 0:  # not enough room above the box: flip below it
        top = y
    top = max(0, min(height - plate_h, top))
    left = max(0, min(width - plate_w, x))

    cv2.rectangle(image, (left, top), (left + plate_w, top + plate_h), color, cv2.FILLED)
    # Luminance test picks black or white ink so labels stay readable.
    luminance = 0.114 * color[0] + 0.587 * color[1] + 0.299 * color[2]
    ink = (20, 20, 20) if luminance > 140 else (250, 250, 250)
    cv2.putText(
        image,
        text,
        (left + pad_x, top + plate_h - baseline - pad_y + 1),
        FONT,
        scale,
        ink,
        thickness,
        cv2.LINE_AA,
    )


def draw_objects(image: np.ndarray, objects: list[dict[str, Any]], *, labels: bool = True) -> None:
    height, width = image.shape[:2]
    for item in objects:
        box = _clamp_box(item["box"], width, height)
        if box is None:
            continue
        x1, y1, x2, y2 = box
        color = label_color(item["label"])
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2, cv2.LINE_AA)
        if labels:
            caption = f"{item['label']} {item['conf']:.0%}"
            if item.get("distance_m") is not None:
                caption = f"{caption}  {item['distance_m']:.1f}m"
            _draw_plate(image, caption, (x1, y1), color)


def draw_faces(image: np.ndarray, faces: list[dict[str, Any]], *, labels: bool = True) -> None:
    height, width = image.shape[:2]
    for face in faces:
        box = _clamp_box(face["box"], width, height)
        if box is None:
            continue
        x1, y1, x2, y2 = box
        known = face.get("name") not in (None, "Unknown")
        color = COLOR_FACE_KNOWN if known else COLOR_FACE_UNKNOWN
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2, cv2.LINE_AA)

        if not labels:
            continue

        caption = face.get("name") or "Unknown"
        similarity = face.get("similarity")
        if known and similarity is not None:
            caption = f"{caption} ({similarity:.2f})"
        if face.get("distance_m") is not None:
            caption = f"{caption}  {face['distance_m']:.2f}m"
        _draw_plate(image, caption, (x1, y1), color)

        emotion = face.get("emotion")
        if emotion:
            _draw_plate(
                image,
                f"{emotion['label']} {emotion['conf']:.0%}",
                (x1, y2 + 1 + 22),
                (200, 160, 255),
                scale=0.42,
            )


def draw_texts(image: np.ndarray, texts: list[dict[str, Any]], *, labels: bool = True) -> None:
    for item in texts:
        quad = item.get("quad")
        if quad:
            points = np.array(quad, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(image, [points], True, COLOR_TEXT_REGION, 2, cv2.LINE_AA)
            top_left = (int(min(p[0] for p in quad)), int(min(p[1] for p in quad)))
        else:
            box = _clamp_box(item["box"], image.shape[1], image.shape[0])
            if box is None:
                continue
            x1, y1, x2, y2 = box
            cv2.rectangle(image, (x1, y1), (x2, y2), COLOR_TEXT_REGION, 2, cv2.LINE_AA)
            top_left = (x1, y1)
        if labels:
            _draw_plate(image, item["text"][:32], top_left, COLOR_TEXT_REGION, scale=0.42)


def draw_hud(image: np.ndarray, lines: list[str]) -> None:
    """Translucent stats panel in the top-left corner."""
    if not lines:
        return

    scale, thickness = 0.44, 1
    sizes = [cv2.getTextSize(line, FONT, scale, thickness) for line in lines]
    row_h = max(size[0][1] + size[1] for size in sizes) + 7
    panel_w = max(size[0][0] for size in sizes) + 18
    panel_h = row_h * len(lines) + 10

    panel_w = min(panel_w, image.shape[1] - 12)
    panel_h = min(panel_h, image.shape[0] - 12)

    roi = image[6 : 6 + panel_h, 6 : 6 + panel_w]
    if roi.size:
        # One vectorised blend beats building an overlay copy of the whole frame.
        cv2.addWeighted(roi, 0.35, np.full_like(roi, COLOR_HUD_BG, dtype=np.uint8), 0.65, 0, roi)

    for index, line in enumerate(lines):
        cv2.putText(
            image,
            line,
            (15, 6 + 8 + row_h * index + sizes[index][0][1]),
            FONT,
            scale,
            COLOR_HUD_FG,
            thickness,
            cv2.LINE_AA,
        )


def annotate(
    image: np.ndarray,
    result: dict[str, Any] | None,
    *,
    draw_labels: bool = True,
    hud_lines: list[str] | None = None,
) -> np.ndarray:
    """Composite every inference layer onto `image` in place."""
    if result:
        draw_objects(image, result.get("objects", []), labels=draw_labels)
        draw_texts(image, result.get("texts", []), labels=draw_labels)
        # Faces last so identity labels win the z-order over object boxes.
        draw_faces(image, result.get("faces", []), labels=draw_labels)
    if hud_lines:
        draw_hud(image, hud_lines)
    return image
