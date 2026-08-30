"""FastAPI application: WHIP ingest, annotated egress, metadata websocket.

Signalling is single-shot SDP exchange (WHIP-style, no trickle ICE): aiortc
finishes ICE gathering inside `setLocalDescription`, so the answer we return
already contains every candidate. The browser side mirrors this by waiting for
`iceGatheringState === 'complete'` before POSTing its offer.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pipeline.vision_engine import InferenceRuntime
from utils.config import SETTINGS
from utils.security import extract_token, token_matches
from webrtc_manager import SessionError, SessionManager

logging.basicConfig(
    level=getattr(logging, SETTINGS.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("opencam")

runtime = InferenceRuntime(SETTINGS)
manager = SessionManager(SETTINGS, runtime)

MAX_SDP_BYTES = 256 * 1024
SESSION_ID_MAX = 64


def _validate_session_id(session_id: str) -> str:
    session_id = session_id.strip()
    if not session_id or len(session_id) > SESSION_ID_MAX:
        raise SessionError("session_id must be 1-64 characters")
    if not all(char.isalnum() or char in "-_." for char in session_id):
        raise SessionError("session_id may only contain alphanumerics, '-', '_' and '.'")
    return session_id


async def _read_sdp(request: Request) -> str:
    body = await request.body()
    if len(body) > MAX_SDP_BYTES:
        raise SessionError("SDP payload too large")
    sdp = body.decode("utf-8", errors="replace").strip()
    if "v=0" not in sdp:
        raise SessionError("body must be a raw SDP offer")
    return sdp


async def _status_heartbeat() -> None:
    """Keeps dashboards live even while a session has no inference running."""
    while True:
        try:
            await asyncio.sleep(2.0)
            for session in list(manager.sessions.values()):
                if session.websockets:
                    await session.broadcast(
                        {"type": "status", "ts": time.time(), **session.describe()}
                    )
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("heartbeat error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading models from %s ...", SETTINGS.model_dir)
    # Model loading is blocking and slow; keep the event loop responsive.
    bundle = await asyncio.get_running_loop().run_in_executor(runtime.executor, runtime.warmup)
    logger.info("Pipeline capabilities: %s", bundle.capabilities())
    logger.info("Known identities: %s", runtime.known_identities() or "-")

    await manager.start()
    heartbeat = asyncio.create_task(_status_heartbeat(), name="status-heartbeat")
    try:
        yield
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat
        await manager.shutdown()
        runtime.shutdown()


app = FastAPI(title="OpenCam Vision Pipeline", version="1.0.0", lifespan=lifespan)

# Routes that must stay reachable without a token: the health probe (Docker
# runs it with no credentials) and CORS preflight (browsers never attach auth
# to OPTIONS).
PUBLIC_PATHS = {"/api/health"}


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Bearer-token gate for /api/*. Inert until OPENCAM_API_TOKEN is set."""
    if (
        SETTINGS.api_token
        and request.url.path.startswith("/api/")
        and request.url.path not in PUBLIC_PATHS
        and request.method != "OPTIONS"
    ):
        presented = extract_token(
            request.headers.get("Authorization"), request.query_params.get("token")
        )
        if not token_matches(SETTINGS.api_token, presented):
            # 401 with no detail: never confirm whether a token merely expired,
            # was malformed, or was close to correct.
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


# `allow_origins=["*"]` combined with no authentication let any page the user
# visited drive this API -- start a camera session, read its detections, and use
# the ingest endpoint to probe the internal network. Default to localhost.
_origins = [o.strip() for o in SETTINGS.cors_origins.split(",") if o.strip()]
if _origins == ["*"]:
    logger.warning(
        "CORS_ALLOW_ORIGINS='*' allows any website to call this API. "
        "Set OPENCAM_API_TOKEN, or restrict the origin list."
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Location"],
)


@app.exception_handler(SessionError)
async def session_error_handler(_: Request, exc: SessionError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"error": str(exc)})


# --------------------------------------------------------------------------
# Introspection
# --------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "sessions": len(manager.sessions), "ts": time.time()}


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "capabilities": runtime.capabilities(),
        "identities": runtime.known_identities(),
        "inference": {
            "max_side": SETTINGS.inference_max_side,
            "min_interval_ms": SETTINGS.min_inference_interval_ms,
            "ocr_every_n": SETTINGS.ocr_every_n,
            "max_workers": SETTINGS.max_workers,
        },
        "distance": {
            "enabled": SETTINGS.distance_enabled,
            "camera_hfov_deg": SETTINGS.camera_hfov_deg,
            "ipd_m": SETTINGS.face_ipd_m,
        },
        "people": {"enabled": SETTINGS.people_enabled},
        "ingest": {
            "enabled": SETTINGS.ingest_enabled,
            "allowed_schemes": [
                s.strip() for s in SETTINGS.ingest_allowed_schemes.split(",") if s.strip()
            ],
        },
    }


@app.get("/api/sessions")
async def list_sessions() -> dict[str, Any]:
    return {"sessions": manager.describe_all()}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    session = manager.get(_validate_session_id(session_id))
    if session is None:
        raise SessionError(f"unknown session '{session_id}'")
    return session.describe()


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, Any]:
    closed = await manager.close_session(_validate_session_id(session_id))
    return {"closed": closed}


# --------------------------------------------------------------------------
# Faces
# --------------------------------------------------------------------------


@app.get("/api/faces")
async def list_faces() -> dict[str, Any]:
    return {"identities": runtime.known_identities(), "dir": str(SETTINGS.faces_dir)}


@app.post("/api/faces/reload")
async def reload_faces() -> dict[str, Any]:
    reloaded = await asyncio.get_running_loop().run_in_executor(
        runtime.executor, runtime.reload_faces
    )
    return {"bundles_reloaded": reloaded, "identities": runtime.known_identities()}


# --------------------------------------------------------------------------
# WHIP ingest (browser -> engine)
# --------------------------------------------------------------------------


@app.post("/api/ingest/{session_id}")
async def start_ingest(session_id: str, request: Request) -> dict[str, Any]:
    """Attach a server-pulled source (IP camera, RTSP, HTTP video, file).

    The browser never touches this media; the backend opens it with ffmpeg and
    feeds it into the same ingress relay a WebRTC publisher would. Viewers and
    the metadata websocket behave identically either way.
    """
    session_id = _validate_session_id(session_id)
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise SessionError("body must be JSON: {\"url\": \"rtsp://...\"}") from exc

    if not isinstance(body, dict) or not body.get("url"):
        raise SessionError('body must be JSON with a "url" field')

    session = await manager.get_or_create(session_id)
    return await session.start_ingest(
        str(body["url"]),
        loop_file=bool(body.get("loop", False)),
        rtsp_transport=str(body.get("rtsp_transport", "tcp")),
        audio=bool(body.get("audio", True)),
        format_hint=body.get("format") or None,
        width=body.get("width"),
        height=body.get("height"),
        fps=body.get("fps"),
    )


@app.delete("/api/ingest/{session_id}")
async def stop_ingest(session_id: str) -> dict[str, Any]:
    session_id = _validate_session_id(session_id)
    session = manager.get(session_id)
    if session is None:
        return {"stopped": False}
    return {"stopped": await session.stop_ingest()}


@app.post("/api/whip/{session_id}")
async def whip_publish(session_id: str, request: Request) -> Response:
    session_id = _validate_session_id(session_id)
    offer_sdp = await _read_sdp(request)

    session = await manager.get_or_create(session_id)
    answer_sdp = await session.handle_publish(offer_sdp)

    return Response(
        content=answer_sdp,
        status_code=201,
        media_type="application/sdp",
        headers={"Location": f"/api/whip/{session_id}"},
    )


@app.delete("/api/whip/{session_id}")
async def whip_stop(session_id: str) -> dict[str, Any]:
    session = manager.get(_validate_session_id(session_id))
    if session is None:
        return {"stopped": False}
    await session.stop_publisher()
    return {"stopped": True}


# --------------------------------------------------------------------------
# Annotated egress (engine -> browser)
# --------------------------------------------------------------------------


@app.post("/api/watch/{session_id}")
async def watch(session_id: str, request: Request) -> Response:
    session_id = _validate_session_id(session_id)
    offer_sdp = await _read_sdp(request)

    session = manager.get(session_id)
    if session is None:
        raise SessionError(f"unknown session '{session_id}'")

    # ?annotated=0 yields the clean inbound video (useful for server ingest,
    # where the caller has no local copy of the source).
    annotated = request.query_params.get("annotated", "1").lower() not in {"0", "false", "no"}
    viewer_id, answer_sdp = await session.handle_watch(offer_sdp, annotated=annotated)
    return Response(
        content=answer_sdp,
        status_code=201,
        media_type="application/sdp",
        headers={"Location": f"/api/watch/{session_id}/{viewer_id}"},
    )


@app.delete("/api/watch/{session_id}/{viewer_id}")
async def stop_watch(session_id: str, viewer_id: str) -> dict[str, Any]:
    session = manager.get(_validate_session_id(session_id))
    if session is None:
        return {"stopped": False}
    await session.drop_viewer(viewer_id)
    return {"stopped": True}


# --------------------------------------------------------------------------
# Metadata websocket
# --------------------------------------------------------------------------


@app.websocket("/ws/{session_id}")
async def metadata_socket(websocket: WebSocket, session_id: str) -> None:
    if SETTINGS.api_token:
        # A browser cannot attach an Authorization header to a WebSocket
        # handshake, so the query parameter is the only portable channel.
        presented = extract_token(
            websocket.headers.get("Authorization"),
            websocket.query_params.get("token"),
        )
        if not token_matches(SETTINGS.api_token, presented):
            await websocket.close(code=4401)
            return
    try:
        session_id = _validate_session_id(session_id)
    except SessionError as exc:
        await websocket.close(code=1008, reason=str(exc))
        return

    # Capacity is resolved BEFORE accept(): closing after the handshake looks
    # like a successful connection to the client, which hides the limit and
    # invites a reconnect loop. Refusing the upgrade is unambiguous.
    try:
        session = await manager.get_or_create(session_id)
        if len(session.websockets) >= SETTINGS.max_sockets_per_session:
            raise SessionError(
                f"session '{session_id}' is at its subscriber limit "
                f"({SETTINGS.max_sockets_per_session})"
            )
    except SessionError as exc:
        await websocket.close(code=1013, reason=str(exc)[:120])
        return

    await websocket.accept()
    try:
        session.add_websocket(websocket)
    except SessionError as exc:
        # Lost a race with another subscriber between the check and the add.
        await websocket.close(code=1013, reason=str(exc)[:120])
        return
    logger.info("[%s] websocket connected (%d total)", session_id, len(session.websockets))

    try:
        await websocket.send_json(
            {
                "type": "hello",
                "session_id": session_id,
                "capabilities": runtime.capabilities(),
                "identities": runtime.known_identities(),
                "ts": time.time(),
                **session.describe(),
            }
        )
        while True:
            message = await websocket.receive_text()
            # The only inbound message this endpoint understands is a heartbeat.
            # Anything larger is either a bug or an attempt to make the server
            # buffer attacker-controlled data.
            if len(message) > 512:
                await websocket.close(code=1009, reason="message too large")
                return
            session.touch()
            if message == "ping" or '"ping"' in message:
                await websocket.send_json({"type": "pong", "ts": time.time()})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("[%s] websocket error", session_id, exc_info=True)
    finally:
        session.remove_websocket(websocket)
        logger.info("[%s] websocket disconnected", session_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        log_level=SETTINGS.log_level.lower(),
    )
