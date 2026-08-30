"""YOLOv8n object detection via ONNX Runtime.

The exported YOLOv8 graph emits a single tensor shaped (1, 4 + num_classes,
num_anchors) with boxes already decoded to cx/cy/w/h in *letterboxed* input
space. There is no NMS baked into the graph, so we run OpenCV's batched NMS
ourselves — it is C++ and costs well under a millisecond at this scale.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

COCO_CLASSES: tuple[str, ...] = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
)


class ObjectDetector:
    """Stateless YOLOv8 ONNX detector. Safe to call from a worker thread."""

    def __init__(
        self,
        model_path: Path,
        *,
        input_size: int = 640,
        conf_threshold: float = 0.35,
        iou_threshold: float = 0.45,
        num_threads: int = 2,
        providers: list[str] | None = None,
    ) -> None:
        self.available = False
        self.input_size = input_size
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        self.class_names: tuple[str, ...] = COCO_CLASSES

        if not model_path.exists():
            logger.warning("Object detector disabled: model not found at %s", model_path)
            return

        try:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = num_threads
            options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            # Sequential execution keeps thread pressure predictable when several
            # sessions each own a runtime.
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

            if providers is None:
                installed = ort.get_available_providers()
                providers = [p for p in ("CUDAExecutionProvider",) if p in installed]
                providers.append("CPUExecutionProvider")

            self.session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=providers
            )
            self.input_name = self.session.get_inputs()[0].name

            shape = self.session.get_inputs()[0].shape
            if isinstance(shape[2], int) and isinstance(shape[3], int):
                self.input_size = int(shape[2])

            self.available = True
            logger.info(
                "Object detector ready: %s (input=%d, providers=%s)",
                model_path.name,
                self.input_size,
                self.session.get_providers(),
            )
        except Exception:  # pragma: no cover - defensive startup path
            logger.exception("Object detector disabled: failed to load %s", model_path)

    # -- preprocessing ----------------------------------------------------

    def _letterbox(self, image: np.ndarray) -> tuple[np.ndarray, float, int, int]:
        """Resize preserving aspect ratio, pad to a square canvas."""
        height, width = image.shape[:2]
        size = self.input_size
        scale = min(size / width, size / height)
        new_w, new_h = int(round(width * scale)), int(round(height * scale))

        resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((size, size, 3), 114, dtype=np.uint8)
        pad_x, pad_y = (size - new_w) // 2, (size - new_h) // 2
        canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized
        return canvas, scale, pad_x, pad_y

    # -- inference --------------------------------------------------------

    def detect(self, frame_bgr: np.ndarray) -> list[dict[str, Any]]:
        if not self.available:
            return []

        canvas, scale, pad_x, pad_y = self._letterbox(frame_bgr)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, swapRB=True)

        outputs = self.session.run(None, {self.input_name: blob})[0]
        # (1, 84, 8400) -> (8400, 84)
        predictions = np.squeeze(outputs, axis=0).T

        class_scores = predictions[:, 4:]
        confidences = class_scores.max(axis=1)
        keep = confidences >= self.conf_threshold
        if not np.any(keep):
            return []

        predictions = predictions[keep]
        confidences = confidences[keep]
        class_ids = class_scores[keep].argmax(axis=1)

        # cx,cy,w,h (letterbox space) -> x,y,w,h (source pixel space)
        cx, cy, bw, bh = predictions[:, 0], predictions[:, 1], predictions[:, 2], predictions[:, 3]
        x = (cx - bw / 2 - pad_x) / scale
        y = (cy - bh / 2 - pad_y) / scale
        w = bw / scale
        h = bh / scale

        boxes = np.stack([x, y, w, h], axis=1)
        indices = cv2.dnn.NMSBoxes(
            boxes.tolist(), confidences.tolist(), self.conf_threshold, self.iou_threshold
        )
        if len(indices) == 0:
            return []

        frame_h, frame_w = frame_bgr.shape[:2]
        results: list[dict[str, Any]] = []
        for index in np.array(indices).reshape(-1):
            bx, by, bw_, bh_ = boxes[index]
            # Clamp to the frame so client-side overlays never draw off-canvas.
            x1 = max(0.0, float(bx))
            y1 = max(0.0, float(by))
            x2 = min(float(frame_w), float(bx + bw_))
            y2 = min(float(frame_h), float(by + bh_))
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue

            class_id = int(class_ids[index])
            label = (
                self.class_names[class_id]
                if class_id < len(self.class_names)
                else f"class_{class_id}"
            )
            results.append(
                {
                    "label": label,
                    "class_id": class_id,
                    "conf": round(float(confidences[index]), 3),
                    "box": [round(x1, 1), round(y1, 1), round(x2 - x1, 1), round(y2 - y1, 1)],
                }
            )

        results.sort(key=lambda item: item["conf"], reverse=True)
        return results
