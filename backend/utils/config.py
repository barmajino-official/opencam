"""Runtime configuration.

Everything is driven by environment variables so the same image can be tuned
per-deployment without a rebuild. Plain os.environ parsing keeps the dependency
surface (and therefore the image) minimal.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_str(key: str, default: str) -> str:
    value = os.environ.get(key)
    return default if value is None or value == "" else value


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env_str(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(_env_str(key, str(default)))
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    return _env_str(key, "1" if default else "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


@dataclass(frozen=True)
class Settings:
    # --- paths ---
    model_dir: Path = field(default_factory=lambda: Path(_env_str("MODEL_DIR", "/models")))
    faces_dir: Path = field(default_factory=lambda: Path(_env_str("FACES_DIR", "/faces")))

    # --- server ---
    # Loopback by default. This service had no authentication and binding it to
    # 0.0.0.0 published an unauthenticated camera + SSRF-capable API to the
    # entire LAN. Set BACKEND_HOST=0.0.0.0 deliberately, and set an API token
    # when you do.
    host: str = field(default_factory=lambda: _env_str("BACKEND_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("BACKEND_PORT", 8080))
    log_level: str = field(default_factory=lambda: _env_str("LOG_LEVEL", "INFO"))

    # --- inference execution ---
    # Threads handed to ONNX Runtime / OpenCV DNN per session-worker.
    inference_threads: int = field(default_factory=lambda: _env_int("INFERENCE_THREADS", 2))
    # Hard cap on concurrently-running inference jobs across all sessions.
    max_workers: int = field(default_factory=lambda: _env_int("MAX_WORKERS", 4))
    # Longest edge the frame is downscaled to before inference. The annotated
    # re-broadcast still renders at full source resolution.
    inference_max_side: int = field(default_factory=lambda: _env_int("INFERENCE_MAX_SIDE", 640))
    # Minimum wall-clock gap between two inference passes (ms). Acts as a soft
    # FPS ceiling so a fast machine does not burn 100% CPU for no visible gain.
    min_inference_interval_ms: float = field(
        default_factory=lambda: _env_float("MIN_INFERENCE_INTERVAL_MS", 40.0)
    )

    # --- object detection ---
    detector_enabled: bool = field(default_factory=lambda: _env_bool("DETECTOR_ENABLED", True))
    detector_model: str = field(default_factory=lambda: _env_str("DETECTOR_MODEL", "yolov8n.onnx"))
    detector_conf: float = field(default_factory=lambda: _env_float("DETECTOR_CONF", 0.35))
    detector_iou: float = field(default_factory=lambda: _env_float("DETECTOR_IOU", 0.45))
    detector_input: int = field(default_factory=lambda: _env_int("DETECTOR_INPUT", 640))

    # --- faces ---
    face_enabled: bool = field(default_factory=lambda: _env_bool("FACE_ENABLED", True))
    face_detect_model: str = field(
        default_factory=lambda: _env_str("FACE_DETECT_MODEL", "face_detection_yunet_2023mar.onnx")
    )
    face_recog_model: str = field(
        default_factory=lambda: _env_str("FACE_RECOG_MODEL", "face_recognition_sface_2021dec.onnx")
    )
    face_score_threshold: float = field(
        default_factory=lambda: _env_float("FACE_SCORE_THRESHOLD", 0.85)
    )
    # SFace cosine-similarity threshold. OpenCV's reference value is 0.363.
    face_match_threshold: float = field(
        default_factory=lambda: _env_float("FACE_MATCH_THRESHOLD", 0.363)
    )
    face_max_faces: int = field(default_factory=lambda: _env_int("FACE_MAX_FACES", 6))
    face_reload_interval_s: float = field(
        default_factory=lambda: _env_float("FACE_RELOAD_INTERVAL_S", 5.0)
    )

    # --- emotion ---
    emotion_enabled: bool = field(default_factory=lambda: _env_bool("EMOTION_ENABLED", True))
    emotion_model: str = field(
        default_factory=lambda: _env_str(
            "EMOTION_MODEL", "facial_expression_recognition_mobilefacenet_2022july.onnx"
        )
    )
    emotion_max_faces: int = field(default_factory=lambda: _env_int("EMOTION_MAX_FACES", 3))
    # Derived "Thinking" label: see pipeline/emotion.py for the exact rule.
    emotion_thinking_heuristic: bool = field(
        default_factory=lambda: _env_bool("EMOTION_THINKING_HEURISTIC", True)
    )
    emotion_thinking_max_conf: float = field(
        default_factory=lambda: _env_float("EMOTION_THINKING_MAX_CONF", 0.55)
    )

    # --- ocr ---
    ocr_enabled: bool = field(default_factory=lambda: _env_bool("OCR_ENABLED", True))
    ocr_detect_model: str = field(
        default_factory=lambda: _env_str("OCR_DETECT_MODEL", "text_detection_en_ppocrv3_2023may.onnx")
    )
    ocr_recog_model: str = field(
        default_factory=lambda: _env_str("OCR_RECOG_MODEL", "text_recognition_CRNN_EN_2021sep.onnx")
    )
    ocr_charset: str = field(default_factory=lambda: _env_str("OCR_CHARSET", "charset_36_EN.txt"))
    # OCR is the most expensive stage; run it on every Nth inference pass only.
    ocr_every_n: int = field(default_factory=lambda: _env_int("OCR_EVERY_N", 6))
    ocr_max_regions: int = field(default_factory=lambda: _env_int("OCR_MAX_REGIONS", 8))
    ocr_min_conf: float = field(default_factory=lambda: _env_float("OCR_MIN_CONF", 0.5))
    ocr_input_width: int = field(default_factory=lambda: _env_int("OCR_INPUT_WIDTH", 736))
    ocr_input_height: int = field(default_factory=lambda: _env_int("OCR_INPUT_HEIGHT", 736))

    # --- distance estimation ---
    # Monocular distance needs a metric prior and a lens angle. HFOV is THE dial
    # that matters: every estimate scales linearly with it. Typical webcams are
    # 55-78 deg; measure yours once and the numbers stop being guesses.
    distance_enabled: bool = field(default_factory=lambda: _env_bool("DISTANCE_ENABLED", True))
    camera_hfov_deg: float = field(default_factory=lambda: _env_float("CAMERA_HFOV_DEG", 60.0))
    face_ipd_m: float = field(default_factory=lambda: _env_float("FACE_IPD_M", 0.063))
    face_width_m: float = field(default_factory=lambda: _env_float("FACE_WIDTH_M", 0.150))

    # --- people fusion / tracking ---
    people_enabled: bool = field(default_factory=lambda: _env_bool("PEOPLE_ENABLED", True))
    # Inference passes a person may go undetected before their id is retired.
    people_max_misses: int = field(default_factory=lambda: _env_int("PEOPLE_MAX_MISSES", 8))

    # --- server-side ingest (IP cameras, RTSP, files) ---
    ingest_enabled: bool = field(default_factory=lambda: _env_bool("INGEST_ENABLED", True))
    # Empty means "any scheme PyAV can open". Set to a comma-separated allowlist
    # (e.g. "rtsp,rtmp") to stop the endpoint being used as an SSRF primitive.
    ingest_allowed_schemes: str = field(
        default_factory=lambda: _env_str("INGEST_ALLOWED_SCHEMES", "rtsp,rtsps,rtmp,rtmps,https")
    )
    ingest_timeout_s: float = field(default_factory=lambda: _env_float("INGEST_TIMEOUT_S", 15.0))
    # When false, ingest refuses URLs resolving to loopback / private /
    # link-local addresses. Turn on ONLY for a trusted LAN of IP cameras.
    ingest_allow_private: bool = field(
        default_factory=lambda: _env_bool("INGEST_ALLOW_PRIVATE", False)
    )

    # --- security ---
    # Empty disables auth (local dev). When set, every /api route and the
    # metadata websocket require this bearer token.
    api_token: str = field(default_factory=lambda: _env_str("OPENCAM_API_TOKEN", ""))
    # Comma-separated origin allowlist, or "*". Defaults to localhost only: with
    # "*" and no auth, any page the user visits can drive this API.
    cors_origins: str = field(
        default_factory=lambda: _env_str(
            "CORS_ALLOW_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
        )
    )

    # --- resource caps (denial-of-service bounds) ---
    max_sessions: int = field(default_factory=lambda: _env_int("MAX_SESSIONS", 16))
    max_viewers_per_session: int = field(
        default_factory=lambda: _env_int("MAX_VIEWERS_PER_SESSION", 8)
    )
    max_sockets_per_session: int = field(
        default_factory=lambda: _env_int("MAX_SOCKETS_PER_SESSION", 16)
    )

    # --- annotation / rebroadcast ---
    draw_labels: bool = field(default_factory=lambda: _env_bool("DRAW_LABELS", True))
    draw_hud: bool = field(default_factory=lambda: _env_bool("DRAW_HUD", True))
    # Annotations older than this are considered stale and are not drawn.
    annotation_ttl_ms: float = field(default_factory=lambda: _env_float("ANNOTATION_TTL_MS", 750.0))

    # --- webrtc ---
    stun_url: str = field(
        default_factory=lambda: _env_str("STUN_URL", "stun:stun.l.google.com:19302")
    )
    session_idle_timeout_s: float = field(
        default_factory=lambda: _env_float("SESSION_IDLE_TIMEOUT_S", 60.0)
    )

    def model_path(self, filename: str) -> Path:
        return self.model_dir / filename


SETTINGS = Settings()
