"""Facial expression recognition (MobileFaceNet backbone, OpenCV Zoo).

The model takes a landmark-aligned 112x112 RGB crop normalised to [-1, 1] and
emits logits over seven classes. We reuse the alignment SFace already computed
for identity matching, so the extra cost per face is one small forward pass.

`Thinking` is not a class the model was trained on. It is derived: a *weakly
confident* neutral prediction with a pensive runner-up (sad / fearful / angry)
is reported as `Thinking`. This is a presentation heuristic, disabled with
EMOTION_THINKING_HEURISTIC=0, and the raw model distribution is always included
in the payload so downstream consumers can ignore it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Output order is fixed by the model's training set (RAF-DB).
MODEL_CLASSES: tuple[str, ...] = (
    "angry",
    "disgust",
    "fearful",
    "happy",
    "neutral",
    "sad",
    "surprised",
)

DISPLAY_NAMES: dict[str, str] = {
    "angry": "Angry",
    "disgust": "Disgust",
    "fearful": "Fear",
    "happy": "Happy",
    "neutral": "Neutral",
    "sad": "Sad",
    "surprised": "Surprised",
}

THINKING_RUNNERS_UP = {"sad", "fearful", "angry"}

_MEAN = np.array([0.5, 0.5, 0.5], dtype=np.float32)
_STD = np.array([0.5, 0.5, 0.5], dtype=np.float32)


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max()
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum()


class EmotionClassifier:
    def __init__(
        self,
        model_path: Path,
        *,
        num_threads: int = 2,
        thinking_heuristic: bool = True,
        thinking_max_conf: float = 0.55,
    ) -> None:
        self.available = False
        self.input_size = (112, 112)
        self.thinking_heuristic = thinking_heuristic
        self.thinking_max_conf = thinking_max_conf

        if not model_path.exists():
            logger.warning("Emotion classifier disabled: model not found at %s", model_path)
            return

        try:
            self.net = cv2.dnn.readNet(str(model_path))
            self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            cv2.setNumThreads(max(1, num_threads))
            self.available = True
            logger.info("Emotion classifier ready: %s", model_path.name)
        except Exception:
            logger.exception("Emotion classifier disabled: failed to load %s", model_path)

    def _preprocess(self, aligned_bgr: np.ndarray) -> np.ndarray:
        if aligned_bgr.shape[:2] != self.input_size:
            aligned_bgr = cv2.resize(aligned_bgr, self.input_size, interpolation=cv2.INTER_LINEAR)
        image = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        image = (image - _MEAN) / _STD
        return cv2.dnn.blobFromImage(image)

    def classify(self, aligned_bgr: np.ndarray) -> dict[str, Any] | None:
        """Classify one landmark-aligned face crop."""
        if not self.available or aligned_bgr is None or aligned_bgr.size == 0:
            return None

        try:
            self.net.setInput(self._preprocess(aligned_bgr))
            logits = self.net.forward().flatten()
        except cv2.error:
            logger.debug("Emotion forward pass failed", exc_info=True)
            return None

        probabilities = _softmax(logits.astype(np.float32))
        order = np.argsort(-probabilities)
        top, runner_up = int(order[0]), int(order[1])
        top_class = MODEL_CLASSES[top]
        confidence = float(probabilities[top])

        label = DISPLAY_NAMES[top_class]
        derived = False
        if (
            self.thinking_heuristic
            and top_class == "neutral"
            and confidence < self.thinking_max_conf
            and MODEL_CLASSES[runner_up] in THINKING_RUNNERS_UP
        ):
            label = "Thinking"
            derived = True

        return {
            "label": label,
            "conf": round(confidence, 3),
            "derived": derived,
            "raw_label": DISPLAY_NAMES[top_class],
            "scores": {
                DISPLAY_NAMES[name]: round(float(probabilities[index]), 3)
                for index, name in enumerate(MODEL_CLASSES)
            },
        }
