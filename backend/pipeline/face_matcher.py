"""Face detection (YuNet) + identity matching (SFace) on top of OpenCV's DNN.

Why not `face_recognition`/dlib or InsightFace? Both pull a heavy native or
PyTorch stack. YuNet (~350 KB) and SFace (~37 MB) are ONNX models with
first-class OpenCV wrappers, run comfortably in real time on a laptop CPU, and
keep the container small.

Reference identities come from a mounted directory:

    /faces/Ali_Jaafar.png        -> "Ali Jaafar"
    /faces/Ali_Jaafar_2.jpg      -> "Ali Jaafar"   (extra sample, same person)
    /faces/Sara_Khoury/front.png -> "Sara Khoury"  (per-person folder)

Every reference embedding is L2-normalised at load time, so matching a probe is
a single matrix-vector product instead of a Python loop.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
_TRAILING_INDEX = re.compile(r"_\d+$")


def _label_from_path(path: Path, root: Path) -> str:
    """`/faces/Ali_Jaafar_2.png` -> `Ali Jaafar`; `/faces/Sara_K/a.png` -> `Sara K`."""
    relative = path.relative_to(root)
    stem = relative.parts[0] if len(relative.parts) > 1 else relative.stem
    stem = _TRAILING_INDEX.sub("", stem)
    return stem.replace("_", " ").replace("-", " ").strip() or "unknown"


class FaceMatcher:
    def __init__(
        self,
        detect_model: Path,
        recog_model: Path,
        faces_dir: Path,
        *,
        score_threshold: float = 0.85,
        nms_threshold: float = 0.3,
        match_threshold: float = 0.363,
        max_faces: int = 6,
        reload_interval_s: float = 5.0,
    ) -> None:
        self.available = False
        self.recognition_available = False
        self.match_threshold = match_threshold
        self.max_faces = max_faces
        self.reload_interval_s = reload_interval_s

        self._lock = threading.Lock()
        self._input_size: tuple[int, int] = (320, 320)
        self._last_reload = 0.0
        self._dir_signature: tuple[Any, ...] = ()

        self.faces_dir = faces_dir
        self.labels: list[str] = []
        self.gallery: np.ndarray = np.zeros((0, 128), dtype=np.float32)

        try:
            if not detect_model.exists():
                raise FileNotFoundError(detect_model)
            self.detector = cv2.FaceDetectorYN.create(
                model=str(detect_model),
                config="",
                input_size=self._input_size,
                score_threshold=score_threshold,
                nms_threshold=nms_threshold,
                top_k=500,
            )
            self.available = True
            logger.info("Face detector ready: %s", detect_model.name)
        except Exception:
            logger.warning("Face detection disabled: could not load %s", detect_model)
            return

        try:
            if not recog_model.exists():
                raise FileNotFoundError(recog_model)
            self.recognizer = cv2.FaceRecognizerSF.create(model=str(recog_model), config="")
            self.recognition_available = True
            logger.info("Face recognition ready: %s", recog_model.name)
        except Exception:
            logger.warning(
                "Face recognition disabled: could not load %s (detection still active)",
                recog_model,
            )

        self.reload_gallery(force=True)

    # -- reference gallery ------------------------------------------------

    def _scan(self) -> list[Path]:
        if not self.faces_dir.is_dir():
            return []
        return sorted(
            path
            for path in self.faces_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
        )

    def _signature(self, paths: list[Path]) -> tuple[Any, ...]:
        return tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths)

    def maybe_reload(self) -> bool:
        """Cheap periodic check so new photos are picked up without a restart."""
        now = time.monotonic()
        if now - self._last_reload < self.reload_interval_s:
            return False
        self._last_reload = now
        return self.reload_gallery(force=False)

    def reload_gallery(self, *, force: bool) -> bool:
        if not self.recognition_available:
            return False

        paths = self._scan()
        try:
            signature = self._signature(paths)
        except OSError:
            return False

        if not force and signature == self._dir_signature:
            return False

        labels: list[str] = []
        embeddings: list[np.ndarray] = []

        for path in paths:
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None:
                logger.warning("Reference face unreadable, skipping: %s", path)
                continue

            faces = self._detect_raw(image)
            if faces is None or len(faces) == 0:
                logger.warning("No face found in reference image, skipping: %s", path)
                continue

            # Largest face wins — reference photos should be a single subject.
            largest = max(faces, key=lambda row: float(row[2]) * float(row[3]))
            try:
                aligned = self.recognizer.alignCrop(image, largest)
                feature = self.recognizer.feature(aligned).flatten().astype(np.float32)
            except cv2.error:
                logger.warning("Failed to embed reference image: %s", path)
                continue

            norm = float(np.linalg.norm(feature))
            if norm < 1e-6:
                continue

            labels.append(_label_from_path(path, self.faces_dir))
            embeddings.append(feature / norm)

        with self._lock:
            self.labels = labels
            self.gallery = (
                np.stack(embeddings).astype(np.float32)
                if embeddings
                else np.zeros((0, 128), dtype=np.float32)
            )
            self._dir_signature = signature

        unique = sorted(set(labels))
        logger.info(
            "Face gallery loaded: %d embedding(s) across %d identit(y|ies): %s",
            len(labels),
            len(unique),
            ", ".join(unique) if unique else "-",
        )
        return True

    # -- detection --------------------------------------------------------

    def _detect_raw(self, image_bgr: np.ndarray) -> np.ndarray | None:
        height, width = image_bgr.shape[:2]
        if (width, height) != self._input_size:
            self.detector.setInputSize((width, height))
            self._input_size = (width, height)
        _, faces = self.detector.detect(image_bgr)
        return faces

    def align(self, image_bgr: np.ndarray, face_row: np.ndarray) -> np.ndarray | None:
        """Landmark-aligned 112x112 crop, shared by the recogniser and the FER model."""
        if not self.recognition_available:
            return None
        try:
            return self.recognizer.alignCrop(image_bgr, face_row)
        except cv2.error:
            return None

    def process(self, frame_bgr: np.ndarray) -> tuple[list[dict[str, Any]], list[np.ndarray]]:
        """Detect faces and resolve identities.

        Returns the JSON-serialisable face records plus the matching raw YuNet
        rows (needed downstream for landmark-accurate alignment).
        """
        if not self.available:
            return [], []

        faces = self._detect_raw(frame_bgr)
        if faces is None or len(faces) == 0:
            return [], []

        # Biggest faces first, then cap: the subject nearest the camera matters most.
        order = np.argsort(-(faces[:, 2] * faces[:, 3]))[: self.max_faces]
        faces = faces[order]

        with self._lock:
            gallery = self.gallery
            labels = self.labels

        records: list[dict[str, Any]] = []
        rows: list[np.ndarray] = []
        frame_h, frame_w = frame_bgr.shape[:2]

        for row in faces:
            x, y, w, h = (float(v) for v in row[:4])
            x1, y1 = max(0.0, x), max(0.0, y)
            x2, y2 = min(float(frame_w), x + w), min(float(frame_h), y + h)
            if x2 - x1 < 8 or y2 - y1 < 8:
                continue

            record: dict[str, Any] = {
                "name": "Unknown",
                "similarity": None,
                "score": round(float(row[14]), 3),
                "box": [round(x1, 1), round(y1, 1), round(x2 - x1, 1), round(y2 - y1, 1)],
                "landmarks": [round(float(v), 1) for v in row[4:14]],
                "emotion": None,
            }

            if self.recognition_available and gallery.shape[0] > 0:
                aligned = self.align(frame_bgr, row)
                if aligned is not None:
                    try:
                        probe = self.recognizer.feature(aligned).flatten().astype(np.float32)
                    except cv2.error:
                        probe = None
                    if probe is not None:
                        norm = float(np.linalg.norm(probe))
                        if norm > 1e-6:
                            # Gallery rows are pre-normalised, so this dot product
                            # *is* the cosine similarity.
                            similarities = gallery @ (probe / norm)
                            best = int(np.argmax(similarities))
                            score = float(similarities[best])
                            record["similarity"] = round(score, 3)
                            if score >= self.match_threshold:
                                record["name"] = labels[best]

            records.append(record)
            rows.append(row)

        return records, rows
