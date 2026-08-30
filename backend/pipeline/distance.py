"""Monocular distance estimation.

A single camera gives no scale: a small object nearby and a large object far
away project to identical pixels. The only way out is a *metric prior* — a
real-world size we are willing to assume — combined with the pinhole model:

    distance = (real_size_metres * focal_length_px) / apparent_size_px

`focal_length_px` is derived from the horizontal field of view, which is a
property of the lens rather than the frame:

    focal_px = (frame_width / 2) / tan(hfov / 2)

Accuracy therefore depends entirely on how good the prior is:

  * **Faces** use interpupillary distance (~63 mm, SD ~3.5 mm across adults).
    This is the tightest prior available in consumer vision, and it is measured
    between two landmarks the detector already produces. Expect +-10% once
    `CAMERA_HFOV_DEG` matches the actual lens.
  * **Objects** use per-class height priors. A "chair" is anywhere from 0.4 m to
    1.2 m tall, so these are order-of-magnitude hints, not measurements. They
    are reported with `"accuracy": "coarse"` so callers can ignore them.

Nothing here is calibrated to your specific lens. `CAMERA_HFOV_DEG` is the one
dial that matters; measure it once (hold a ruler at a known distance and solve
the equation backwards) and every estimate improves proportionally.
"""

from __future__ import annotations

import math
from typing import Any

# Mean adult interpupillary distance in metres (Dodgson 2004, N=3976).
DEFAULT_IPD_M = 0.063
# Bizygomatic (cheekbone) width, used when landmarks are unavailable.
DEFAULT_FACE_WIDTH_M = 0.150

# Real-world *height* priors in metres for the COCO classes where a prior is
# meaningful. Classes whose size varies wildly (kite, book, cake) are omitted
# on purpose: a wrong number is worse than no number.
OBJECT_HEIGHT_M: dict[str, float] = {
    "person": 1.70,
    "bicycle": 1.10,
    "car": 1.50,
    "motorcycle": 1.30,
    "bus": 3.20,
    "truck": 3.20,
    "traffic light": 0.90,
    "stop sign": 0.75,
    "bench": 0.90,
    "cat": 0.30,
    "dog": 0.55,
    "horse": 1.60,
    "sheep": 0.90,
    "cow": 1.50,
    "backpack": 0.50,
    "umbrella": 0.90,
    "bottle": 0.25,
    "wine glass": 0.20,
    "cup": 0.11,
    "fork": 0.19,
    "knife": 0.22,
    "spoon": 0.17,
    "bowl": 0.09,
    "banana": 0.19,
    "chair": 0.90,
    "couch": 0.85,
    "potted plant": 0.45,
    "bed": 0.60,
    "dining table": 0.75,
    "toilet": 0.78,
    "tv": 0.55,
    "laptop": 0.25,
    "mouse": 0.04,
    "remote": 0.16,
    "keyboard": 0.02,
    "cell phone": 0.15,
    "microwave": 0.30,
    "oven": 0.60,
    "sink": 0.20,
    "refrigerator": 1.75,
    "book": 0.24,
    "clock": 0.30,
    "vase": 0.25,
    "teddy bear": 0.35,
}

# Anything outside this band is a projection artefact, not a measurement.
MIN_DISTANCE_M = 0.15
MAX_DISTANCE_M = 60.0


class DistanceEstimator:
    """Pinhole-model distance from size priors. Stateless and thread-safe."""

    def __init__(
        self,
        *,
        hfov_deg: float = 60.0,
        ipd_m: float = DEFAULT_IPD_M,
        face_width_m: float = DEFAULT_FACE_WIDTH_M,
        enabled: bool = True,
    ) -> None:
        self.enabled = enabled
        self.hfov_deg = max(10.0, min(170.0, hfov_deg))
        self.ipd_m = ipd_m
        self.face_width_m = face_width_m
        # tan(hfov/2) is constant per lens; hoist it out of the per-face path.
        self._half_fov_tan = math.tan(math.radians(self.hfov_deg) / 2.0)

    def focal_px(self, frame_width: int) -> float:
        """Focal length in pixels for a frame of this width."""
        return (frame_width / 2.0) / self._half_fov_tan

    @staticmethod
    def _clamp(value: float) -> float | None:
        if not math.isfinite(value) or value < MIN_DISTANCE_M or value > MAX_DISTANCE_M:
            return None
        return round(value, 2)

    def face_distance(
        self, face: dict[str, Any], frame_width: int
    ) -> tuple[float | None, str | None]:
        """Distance to a face. Returns (metres, method) or (None, None).

        Prefers the eye-to-eye span: it is a rigid facial dimension, unaffected
        by the detector's box padding and only mildly affected by head yaw.
        Falls back to box width when landmarks are missing.
        """
        if not self.enabled or frame_width <= 0:
            return None, None

        focal = self.focal_px(frame_width)

        landmarks = face.get("landmarks")
        # YuNet order: right eye, left eye, nose, right mouth, left mouth.
        if isinstance(landmarks, (list, tuple)) and len(landmarks) >= 4:
            dx = float(landmarks[0]) - float(landmarks[2])
            dy = float(landmarks[1]) - float(landmarks[3])
            ipd_px = math.hypot(dx, dy)
            if ipd_px > 1.0:
                metres = self._clamp((self.ipd_m * focal) / ipd_px)
                if metres is not None:
                    return metres, "ipd"

        box = face.get("box")
        if isinstance(box, (list, tuple)) and len(box) == 4 and float(box[2]) > 1.0:
            metres = self._clamp((self.face_width_m * focal) / float(box[2]))
            if metres is not None:
                return metres, "face_width"

        return None, None

    def object_distance(
        self, label: str, box: list[float], frame_width: int
    ) -> tuple[float | None, str | None]:
        """Coarse distance to a detected object from its class height prior."""
        if not self.enabled or frame_width <= 0:
            return None, None

        prior = OBJECT_HEIGHT_M.get(label)
        if prior is None or len(box) != 4:
            return None, None

        height_px = float(box[3])
        if height_px <= 1.0:
            return None, None

        metres = self._clamp((prior * self.focal_px(frame_width)) / height_px)
        return (metres, "class_prior") if metres is not None else (None, None)
