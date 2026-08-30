"""Scene-text detection + recognition using OpenCV's built-in DNN text models.

Stage 1: PP-OCRv3 (English) differentiable-binarisation detector -> rotated quads.
Stage 2: CRNN (English, 36 symbols) recognises each quad after a perspective
         warp to the model's fixed 100x32 input.

PaddleOCR and EasyOCR would work too, but both add hundreds of megabytes (and
EasyOCR pulls PyTorch). These two ONNX graphs total ~14 MB and are driven by
`cv2.dnn.TextDetectionModel_DB` / `cv2.dnn.TextRecognitionModel`, which are
already compiled into the OpenCV wheel.

OCR is by far the heaviest stage, so the vision engine runs it on a reduced
cadence (OCR_EVERY_N) and on the *full-resolution* frame, where small text is
still legible.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Classic ImageNet BGR mean used by the PP-OCR detection head.
_DB_MEAN = (122.67891434, 116.66876762, 104.00698793)
_CRNN_INPUT = (100, 32)
_CRNN_TARGET = np.array([[0, 31], [0, 0], [99, 0], [99, 31]], dtype=np.float32)


class OCREngine:
    def __init__(
        self,
        detect_model: Path,
        recog_model: Path,
        charset_path: Path,
        *,
        input_width: int = 736,
        input_height: int = 736,
        max_regions: int = 8,
        min_conf: float = 0.5,
        num_threads: int = 2,
    ) -> None:
        self.available = False
        self.max_regions = max_regions
        self.min_conf = min_conf
        # DB requires input dimensions that are multiples of 32.
        self.input_size = (max(32, input_width // 32 * 32), max(32, input_height // 32 * 32))

        if not detect_model.exists() or not recog_model.exists():
            logger.warning(
                "OCR disabled: missing model(s) (detect=%s exists=%s, recog=%s exists=%s)",
                detect_model.name,
                detect_model.exists(),
                recog_model.name,
                recog_model.exists(),
            )
            return

        try:
            self.detector = cv2.dnn.TextDetectionModel_DB(str(detect_model))
            self.detector.setBinaryThreshold(0.3)
            self.detector.setPolygonThreshold(0.5)
            self.detector.setUnclipRatio(2.0)
            self.detector.setMaxCandidates(200)
            self.detector.setInputParams(1.0 / 255.0, self.input_size, _DB_MEAN)
            self.detector.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.detector.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

            self.recognizer = cv2.dnn.TextRecognitionModel(str(recog_model))
            self.recognizer.setDecodeType("CTC-greedy")
            self.recognizer.setVocabulary(self._load_charset(charset_path))
            self.recognizer.setInputParams(1.0 / 127.5, _CRNN_INPUT, (127.5, 127.5, 127.5))
            self.recognizer.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.recognizer.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

            cv2.setNumThreads(max(1, num_threads))
            self.available = True
            logger.info(
                "OCR ready: %s + %s (input=%s)",
                detect_model.name,
                recog_model.name,
                self.input_size,
            )
        except Exception:
            logger.exception("OCR disabled: failed to initialise text models")

    @staticmethod
    def _load_charset(charset_path: Path) -> list[str]:
        if charset_path.exists():
            lines = charset_path.read_text(encoding="utf-8").splitlines()
            charset = [line for line in lines if line != ""]
            if charset:
                return charset
        logger.warning("OCR charset missing at %s, using built-in 36-symbol set", charset_path)
        return list("0123456789abcdefghijklmnopqrstuvwxyz")

    def _recognise(self, frame_bgr: np.ndarray, quad: np.ndarray) -> str:
        vertices = quad.reshape((4, 2)).astype(np.float32)
        transform = cv2.getPerspectiveTransform(vertices, _CRNN_TARGET)
        cropped = cv2.warpPerspective(frame_bgr, transform, _CRNN_INPUT)
        # CRNN_EN is a single-channel model.
        grayscale = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        return self.recognizer.recognize(grayscale)

    def read(self, frame_bgr: np.ndarray) -> list[dict[str, Any]]:
        if not self.available:
            return []

        try:
            quads, confidences = self.detector.detect(frame_bgr)
        except cv2.error:
            logger.debug("Text detection failed", exc_info=True)
            return []

        if quads is None or len(quads) == 0:
            return []

        candidates = sorted(
            zip(quads, confidences), key=lambda pair: float(pair[1]), reverse=True
        )[: self.max_regions]

        frame_h, frame_w = frame_bgr.shape[:2]
        results: list[dict[str, Any]] = []

        for quad, confidence in candidates:
            confidence = float(confidence)
            if confidence < self.min_conf:
                continue

            points = np.array(quad, dtype=np.float32).reshape(4, 2)
            # Reject degenerate quads before paying for a warp + forward pass.
            width = float(np.linalg.norm(points[0] - points[3]))
            height = float(np.linalg.norm(points[0] - points[1]))
            if width < 6 or height < 6:
                continue

            try:
                text = self._recognise(frame_bgr, points).strip()
            except cv2.error:
                continue
            if not text:
                continue

            xs, ys = points[:, 0], points[:, 1]
            x1 = float(np.clip(xs.min(), 0, frame_w))
            y1 = float(np.clip(ys.min(), 0, frame_h))
            x2 = float(np.clip(xs.max(), 0, frame_w))
            y2 = float(np.clip(ys.max(), 0, frame_h))

            results.append(
                {
                    "text": text,
                    "conf": round(confidence, 3),
                    "box": [round(x1, 1), round(y1, 1), round(x2 - x1, 1), round(y2 - y1, 1)],
                    "quad": [[round(float(px), 1), round(float(py), 1)] for px, py in points],
                }
            )

        return results
