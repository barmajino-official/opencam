"""Async inference coordination.

Design notes that matter for the <150 ms target:

1. **Latest-frame-wins, never a queue.** A FIFO between capture and inference
   guarantees monotonically growing lag the moment inference is slower than the
   camera. Instead each session owns a *single-slot register*; a new frame
   overwrites whatever is pending. Worst-case lag is therefore bounded by one
   inference pass, no matter how long the stream runs.

2. **Two independent cadences.** Detection + faces + emotion run on every
   dispatched frame; OCR (roughly 5-10x more expensive) runs on its own worker
   at 1/N cadence and its last result is carried forward with a TTL. A slow OCR
   pass can never stall the fast path.

3. **A bounded pool of model bundles.** OpenCV's `cv2.dnn.Net.forward` is *not*
   re-entrant, so bundles are checked out for the duration of a job. Pool size
   equals the thread-pool size, which doubles as the global CPU budget across
   all sessions.

4. **Downscale once, map back once.** Detection and face work happen on a frame
   reduced to `INFERENCE_MAX_SIDE`; results are rescaled to source-pixel space
   so every consumer (overlay, annotator, logs) shares one coordinate system.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Awaitable, Callable

import cv2
import numpy as np

from pipeline.detector import ObjectDetector
from pipeline.distance import DistanceEstimator
from pipeline.emotion import EmotionClassifier
from pipeline.face_matcher import FaceMatcher
from pipeline.ocr_engine import OCREngine
from pipeline.people import PeopleTracker, build_people
from utils.config import Settings

logger = logging.getLogger(__name__)

PublishFn = Callable[[dict[str, Any]], Awaitable[None]]


class ModelBundle:
    """One complete, single-threaded-safe set of models."""

    def __init__(self, settings: Settings, index: int) -> None:
        self.index = index
        started = time.perf_counter()

        self.detector = (
            ObjectDetector(
                settings.model_path(settings.detector_model),
                input_size=settings.detector_input,
                conf_threshold=settings.detector_conf,
                iou_threshold=settings.detector_iou,
                num_threads=settings.inference_threads,
            )
            if settings.detector_enabled
            else None
        )

        self.faces = (
            FaceMatcher(
                settings.model_path(settings.face_detect_model),
                settings.model_path(settings.face_recog_model),
                settings.faces_dir,
                score_threshold=settings.face_score_threshold,
                match_threshold=settings.face_match_threshold,
                max_faces=settings.face_max_faces,
                reload_interval_s=settings.face_reload_interval_s,
            )
            if settings.face_enabled
            else None
        )

        self.emotion = (
            EmotionClassifier(
                settings.model_path(settings.emotion_model),
                num_threads=settings.inference_threads,
                thinking_heuristic=settings.emotion_thinking_heuristic,
                thinking_max_conf=settings.emotion_thinking_max_conf,
            )
            if settings.emotion_enabled
            else None
        )

        self.ocr = (
            OCREngine(
                settings.model_path(settings.ocr_detect_model),
                settings.model_path(settings.ocr_recog_model),
                settings.model_path(settings.ocr_charset),
                input_width=settings.ocr_input_width,
                input_height=settings.ocr_input_height,
                max_regions=settings.ocr_max_regions,
                min_conf=settings.ocr_min_conf,
                num_threads=settings.inference_threads,
            )
            if settings.ocr_enabled
            else None
        )

        logger.info(
            "Model bundle #%d loaded in %.2fs", index, time.perf_counter() - started
        )

    def capabilities(self) -> dict[str, bool]:
        return {
            "objects": bool(self.detector and self.detector.available),
            "faces": bool(self.faces and self.faces.available),
            "face_recognition": bool(self.faces and self.faces.recognition_available),
            "emotion": bool(self.emotion and self.emotion.available),
            "ocr": bool(self.ocr and self.ocr.available),
        }


class InferenceRuntime:
    """Process-wide CPU budget: one thread pool plus a matching bundle pool."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.size = max(1, settings.max_workers)
        self.executor = ThreadPoolExecutor(
            max_workers=self.size, thread_name_prefix="inference"
        )
        self._pool: queue.LifoQueue[ModelBundle] = queue.LifoQueue()
        self._created = 0
        self._create_lock = threading.Lock()
        self._all: list[ModelBundle] = []

    def warmup(self) -> ModelBundle:
        """Build the first bundle eagerly so startup surfaces model problems."""
        bundle = self._checkout()
        self._checkin(bundle)
        return bundle

    def _checkout(self) -> ModelBundle:
        try:
            return self._pool.get_nowait()
        except queue.Empty:
            pass

        with self._create_lock:
            if self._created < self.size:
                self._created += 1
                index = self._created
                bundle = ModelBundle(self.settings, index)
                self._all.append(bundle)
                return bundle
        # Pool is fully built and every bundle is busy: block until one frees up.
        return self._pool.get()

    def _checkin(self, bundle: ModelBundle) -> None:
        self._pool.put(bundle)

    @contextlib.contextmanager
    def lease(self):
        bundle = self._checkout()
        try:
            yield bundle
        finally:
            self._checkin(bundle)

    def reload_faces(self) -> int:
        """Force every bundle to re-read the /faces directory."""
        reloaded = 0
        for bundle in list(self._all):
            if bundle.faces is not None and bundle.faces.recognition_available:
                bundle.faces.reload_gallery(force=True)
                reloaded += 1
        return reloaded

    def known_identities(self) -> list[str]:
        for bundle in self._all:
            if bundle.faces is not None:
                return sorted(set(bundle.faces.labels))
        return []

    def capabilities(self) -> dict[str, bool]:
        if self._all:
            return self._all[0].capabilities()
        return {}

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)


class _Ema:
    """Exponential moving average for rate/latency stats."""

    __slots__ = ("value", "alpha")

    def __init__(self, alpha: float = 0.15) -> None:
        self.value: float | None = None
        self.alpha = alpha

    def update(self, sample: float) -> float:
        self.value = sample if self.value is None else (
            self.alpha * sample + (1 - self.alpha) * self.value
        )
        return self.value

    def get(self, default: float = 0.0) -> float:
        return default if self.value is None else self.value


class VisionEngine:
    def __init__(
        self,
        session_id: str,
        settings: Settings,
        runtime: InferenceRuntime,
        publish: PublishFn,
    ) -> None:
        self.session_id = session_id
        self.settings = settings
        self.runtime = runtime
        self.publish = publish

        # Constructed from inside a coroutine, so the running loop is the right
        # one to capture (get_event_loop() is deprecated for this).
        self._loop = asyncio.get_running_loop()
        self._closed = False
        self._tasks: list[asyncio.Task[None]] = []

        # single-slot registers (latest wins)
        self._slot: tuple[np.ndarray, float] | None = None
        self._slot_ts = 0.0
        self._slot_event = asyncio.Event()

        self._ocr_slot: tuple[np.ndarray, float] | None = None
        self._ocr_event = asyncio.Event()
        self._ocr_busy = False

        self._min_interval = settings.min_inference_interval_ms / 1000.0
        self._last_dispatch = 0.0

        self._seq = 0
        self._frames_in = 0
        self._frames_dropped = 0
        self._last_capture_ts: float | None = None

        self._capture_fps = _Ema()
        self._inference_fps = _Ema()
        self._latency = _Ema()
        self._e2e_latency = _Ema()

        self._texts: list[dict[str, Any]] = []
        self._texts_ts = 0.0
        self._ocr_ms = _Ema()

        # Distance is stateless maths, but the people tracker is per-session
        # mutable state and MUST NOT live on the pooled ModelBundle -- bundles
        # are shared across sessions and would fuse ids between cameras.
        # Mutating these from the worker thread is safe because the single-slot
        # register guarantees one _infer() per session at a time.
        self._distance = DistanceEstimator(
            hfov_deg=settings.camera_hfov_deg,
            ipd_m=settings.face_ipd_m,
            face_width_m=settings.face_width_m,
            enabled=settings.distance_enabled,
        )
        self._people = PeopleTracker(max_misses=settings.people_max_misses)

        self.latest_result: dict[str, Any] | None = None
        self.latest_result_ts = 0.0
        self.audio_level = 0.0

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._main_worker(), name=f"vision-{self.session_id}"),
            asyncio.create_task(self._ocr_worker(), name=f"ocr-{self.session_id}"),
        ]

    async def stop(self) -> None:
        self._closed = True
        self._slot_event.set()
        self._ocr_event.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        self._slot = None
        self._ocr_slot = None

    # -- ingest -----------------------------------------------------------

    def wants_frame(self) -> bool:
        """Lets the track consumer skip the frame->ndarray conversion entirely.

        Converting a 720p frame costs real CPU; there is no point paying for it
        when the pending slot already holds something newer than the pacing
        interval allows us to dispatch.
        """
        if self._closed:
            return False
        if self._slot is None:
            return True
        return (time.monotonic() - self._slot_ts) >= self._min_interval * 0.5

    def submit(self, frame_bgr: np.ndarray, capture_ts: float) -> None:
        if self._closed:
            return

        now = time.monotonic()
        if self._last_capture_ts is not None:
            delta = now - self._last_capture_ts
            if delta > 1e-4:
                self._capture_fps.update(1.0 / delta)
        self._last_capture_ts = now

        self._frames_in += 1
        if self._slot is not None:
            self._frames_dropped += 1

        self._slot = (frame_bgr, capture_ts)
        self._slot_ts = now
        self._slot_event.set()

    def submit_audio_level(self, level: float) -> None:
        self.audio_level = level

    def _take_slot(self) -> tuple[np.ndarray, float] | None:
        item = self._slot
        self._slot = None
        self._slot_event.clear()
        return item

    # -- workers ----------------------------------------------------------

    async def _main_worker(self) -> None:
        while not self._closed:
            try:
                await self._slot_event.wait()
                if self._closed:
                    return

                # Pace *before* taking, so we always grab the freshest frame.
                gap = self._min_interval - (time.monotonic() - self._last_dispatch)
                if gap > 0:
                    await asyncio.sleep(gap)

                item = self._take_slot()
                if item is None:
                    continue

                frame, capture_ts = item
                self._last_dispatch = time.monotonic()
                self._seq += 1
                seq = self._seq

                if (
                    self.settings.ocr_enabled
                    and self.settings.ocr_every_n > 0
                    and seq % self.settings.ocr_every_n == 0
                    and not self._ocr_busy
                ):
                    self._ocr_slot = (frame, capture_ts)
                    self._ocr_event.set()

                started = time.perf_counter()
                result = await self._loop.run_in_executor(
                    self.runtime.executor, self._infer, frame, seq
                )
                elapsed_ms = (time.perf_counter() - started) * 1000.0

                if self._closed or result is None:
                    continue

                self._latency.update(elapsed_ms)
                if elapsed_ms > 1e-4:
                    self._inference_fps.update(
                        1.0 / max(self._min_interval, elapsed_ms / 1000.0)
                    )

                end_to_end_ms = (time.monotonic() - capture_ts) * 1000.0
                self._e2e_latency.update(end_to_end_ms)

                result["latency_ms"] = round(elapsed_ms, 1)
                result["end_to_end_ms"] = round(end_to_end_ms, 1)
                result["stats"] = self.stats()

                self.latest_result = result
                self.latest_result_ts = time.monotonic()
                await self.publish(result)

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[%s] inference loop error", self.session_id)
                await asyncio.sleep(0.1)

    async def _ocr_worker(self) -> None:
        while not self._closed:
            try:
                await self._ocr_event.wait()
                self._ocr_event.clear()
                if self._closed:
                    return

                item = self._ocr_slot
                self._ocr_slot = None
                if item is None:
                    continue

                frame, _ = item
                self._ocr_busy = True
                started = time.perf_counter()
                try:
                    texts = await self._loop.run_in_executor(
                        self.runtime.executor, self._infer_ocr, frame
                    )
                finally:
                    self._ocr_busy = False

                self._ocr_ms.update((time.perf_counter() - started) * 1000.0)
                if texts is not None:
                    self._texts = texts
                    self._texts_ts = time.monotonic()

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[%s] ocr loop error", self.session_id)
                await asyncio.sleep(0.2)

    # -- inference (runs in a worker thread) ------------------------------

    def _infer(self, frame: np.ndarray, seq: int) -> dict[str, Any] | None:
        source_h, source_w = frame.shape[:2]
        proc, scale = self._downscale(frame)

        objects: list[dict[str, Any]] = []
        faces: list[dict[str, Any]] = []

        with self.runtime.lease() as bundle:
            if bundle.detector is not None and bundle.detector.available:
                objects = bundle.detector.detect(proc)

            if bundle.faces is not None and bundle.faces.available:
                bundle.faces.maybe_reload()
                faces, rows = bundle.faces.process(proc)

                if bundle.emotion is not None and bundle.emotion.available and faces:
                    limit = self.settings.emotion_max_faces
                    for face, row in list(zip(faces, rows))[:limit]:
                        aligned = bundle.faces.align(proc, row)
                        if aligned is None:
                            aligned = self._fallback_crop(proc, face["box"])
                        if aligned is not None:
                            face["emotion"] = bundle.emotion.classify(aligned)

        if scale != 1.0:
            inverse = 1.0 / scale
            self._rescale(objects, inverse)
            self._rescale(faces, inverse)

        # Distance is computed after the rescale so every input is already in
        # source-frame pixels -- the one coordinate system that leaves this file.
        if self.settings.distance_enabled:
            for face in faces:
                metres, method = self._distance.face_distance(face, source_w)
                face["distance_m"] = metres
                face["distance_method"] = method
            for obj in objects:
                metres, method = self._distance.object_distance(
                    obj["label"], obj["box"], source_w
                )
                obj["distance_m"] = metres
                obj["distance_method"] = method

        people = (
            build_people(objects, faces, self._people)
            if self.settings.people_enabled
            else []
        )

        texts = self._fresh_texts()

        return {
            "type": "inference",
            "session_id": self.session_id,
            "seq": seq,
            "ts": time.time(),
            "frame": {"w": source_w, "h": source_h},
            "objects": objects,
            "faces": faces,
            "people": people,
            "texts": texts,
            "audio": {"level": round(self.audio_level, 4)},
        }

    def _infer_ocr(self, frame: np.ndarray) -> list[dict[str, Any]]:
        # OCR deliberately runs on the full-resolution frame: at 640px small
        # scene text is already unreadable to the recogniser.
        with self.runtime.lease() as bundle:
            if bundle.ocr is None or not bundle.ocr.available:
                return []
            return bundle.ocr.read(frame)

    def _downscale(self, frame: np.ndarray) -> tuple[np.ndarray, float]:
        height, width = frame.shape[:2]
        longest = max(width, height)
        target = self.settings.inference_max_side
        if longest <= target:
            return frame, 1.0
        scale = target / longest
        resized = cv2.resize(
            frame,
            (int(round(width * scale)), int(round(height * scale))),
            interpolation=cv2.INTER_LINEAR,
        )
        return resized, scale

    @staticmethod
    def _rescale(items: list[dict[str, Any]], factor: float) -> None:
        for item in items:
            item["box"] = [round(value * factor, 1) for value in item["box"]]
            if "landmarks" in item:
                item["landmarks"] = [round(value * factor, 1) for value in item["landmarks"]]

    @staticmethod
    def _fallback_crop(frame: np.ndarray, box: list[float]) -> np.ndarray | None:
        """Used when SFace (and therefore landmark alignment) is unavailable."""
        x, y, w, h = (int(round(v)) for v in box)
        height, width = frame.shape[:2]
        x1, y1 = max(0, x), max(0, y)
        x2, y2 = min(width, x + w), min(height, y + h)
        if x2 - x1 < 8 or y2 - y1 < 8:
            return None
        return cv2.resize(frame[y1:y2, x1:x2], (112, 112), interpolation=cv2.INTER_LINEAR)

    def _fresh_texts(self) -> list[dict[str, Any]]:
        if not self._texts:
            return []
        age_ms = (time.monotonic() - self._texts_ts) * 1000.0
        # Text lives longer than a single frame, but not forever.
        if age_ms > max(2000.0, self.settings.annotation_ttl_ms * 4):
            return []
        return self._texts

    def reset_tracking(self) -> None:
        """Drop person ids. Called when the source changes underneath us."""
        self._people.reset()

    # -- introspection ----------------------------------------------------

    def stats(self) -> dict[str, Any]:
        return {
            "capture_fps": round(self._capture_fps.get(), 1),
            "inference_fps": round(self._inference_fps.get(), 1),
            "inference_ms": round(self._latency.get(), 1),
            "end_to_end_ms": round(self._e2e_latency.get(), 1),
            "ocr_ms": round(self._ocr_ms.get(), 1),
            "frames_in": self._frames_in,
            "frames_dropped": self._frames_dropped,
            "seq": self._seq,
        }

    def hud_lines(self) -> list[str]:
        stats = self.stats()
        return [
            f"session {self.session_id}",
            f"cap {stats['capture_fps']:.0f}fps  inf {stats['inference_fps']:.0f}fps",
            f"lag {stats['end_to_end_ms']:.0f}ms  ({stats['inference_ms']:.0f}ms model)",
            f"drop {stats['frames_dropped']}/{stats['frames_in']}",
        ]

    def annotation_for_render(self) -> dict[str, Any] | None:
        """Latest result, or None once it is too stale to be trustworthy."""
        if self.latest_result is None:
            return None
        age_ms = (time.monotonic() - self.latest_result_ts) * 1000.0
        if age_ms > self.settings.annotation_ttl_ms:
            return None
        return self.latest_result
