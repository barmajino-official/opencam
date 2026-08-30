"""WebRTC session lifecycle: ingest, inference fan-out, annotated egress.

Media graph for one session:

    browser (publisher)
        |  WHIP / SDP
        v
    RTCPeerConnection  --video-->  MediaRelay (ingress)
                                     |-- subscription A --> inference consumer
                                     |                        (frame -> VisionEngine)
                                     '-- subscription B --> AnnotatedVideoTrack
                                                                   |
                                                            MediaRelay (egress)
                                                                   |-- viewer 1
                                                                   '-- viewer N
                       --audio-->  MediaRelay (ingress)
                                     |-- level meter (RMS -> websocket)
                                     '-- viewer N (pass-through)

The two relays matter. The ingress relay lets inference and annotation each pull
from the same inbound track without stealing frames from one another; the egress
relay means annotation is rendered **once** regardless of how many people are
watching. All subscriptions are `buffered=False`, so a slow consumer drops
frames instead of accumulating latency.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import urllib.parse
import uuid
from typing import Any

import numpy as np
from aiortc import (
    MediaStreamTrack,
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.contrib.media import MediaPlayer, MediaRelay
from av import VideoFrame

from pipeline.vision_engine import InferenceRuntime, VisionEngine
from utils.config import Settings
from utils.drawing import annotate
from utils.security import UrlNotAllowed, validate_ingest_url

logger = logging.getLogger(__name__)


class SessionError(Exception):
    """Raised for client-correctable problems (missing publisher, bad SDP)."""


class AnnotatedVideoTrack(MediaStreamTrack):
    """Composites the newest inference result onto the live video track.

    Timestamps are copied from the source frame rather than regenerated, so the
    annotated stream keeps the publisher's pacing and stays A/V-synced with the
    pass-through audio track.
    """

    kind = "video"

    def __init__(self, source: MediaStreamTrack, session: "Session") -> None:
        super().__init__()
        self.source = source
        self.session = session
        self._frames = 0

    async def recv(self) -> VideoFrame:
        frame = await self.source.recv()

        settings = self.session.settings
        result = self.session.engine.annotation_for_render()
        hud = self.session.engine.hud_lines() if settings.draw_hud else None

        if result is None and not hud:
            return frame

        image = frame.to_ndarray(format="bgr24")
        annotate(image, result, draw_labels=settings.draw_labels, hud_lines=hud)

        annotated = VideoFrame.from_ndarray(image, format="bgr24")
        annotated.pts = frame.pts
        annotated.time_base = frame.time_base
        self._frames += 1
        return annotated


class Session:
    def __init__(self, session_id: str, settings: Settings, runtime: InferenceRuntime) -> None:
        self.id = session_id
        self.settings = settings
        self.runtime = runtime
        self.created_at = time.time()
        self.last_activity = time.monotonic()

        self.engine = VisionEngine(session_id, settings, runtime, self._publish)
        self.engine.start()

        self.ingress = MediaRelay()
        self.egress = MediaRelay()

        self.publisher_pc: RTCPeerConnection | None = None
        # Server-side pull source (RTSP / HTTP / file), mutually exclusive with
        # a WebRTC publisher: both feed the same ingress relay.
        self.ingest_player: MediaPlayer | None = None
        self.ingest_url: str | None = None
        self.video_track: MediaStreamTrack | None = None
        self.audio_track: MediaStreamTrack | None = None
        self.annotated_track: AnnotatedVideoTrack | None = None

        self.viewers: dict[str, RTCPeerConnection] = {}
        self.websockets: set[Any] = set()

        self._tasks: set[asyncio.Task[None]] = set()
        self._closing = False

    # -- helpers ----------------------------------------------------------

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def _spawn(self, coro, name: str) -> None:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _ice_configuration(self) -> RTCConfiguration:
        if not self.settings.stun_url:
            return RTCConfiguration(iceServers=[])
        return RTCConfiguration(iceServers=[RTCIceServer(urls=[self.settings.stun_url])])

    @property
    def has_publisher(self) -> bool:
        return self.video_track is not None

    @property
    def source_kind(self) -> str:
        if self.ingest_player is not None:
            return "ingest"
        if self.publisher_pc is not None:
            return "webrtc"
        return "none"

    def describe(self) -> dict[str, Any]:
        return {
            "session_id": self.id,
            "created_at": self.created_at,
            "publishing": self.has_publisher,
            "source": self.source_kind,
            "source_url": self.ingest_url,
            "has_audio": self.audio_track is not None,
            "viewers": len(self.viewers),
            "subscribers": len(self.websockets),
            "idle_s": round(time.monotonic() - self.last_activity, 1),
            "stats": self.engine.stats(),
        }

    # -- websocket fan-out ------------------------------------------------

    async def _publish(self, message: dict[str, Any]) -> None:
        await self.broadcast(message)

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.websockets:
            return
        # Serialise once, not once per client.
        payload = json.dumps(message, separators=(",", ":"))
        dead: list[Any] = []
        for websocket in list(self.websockets):
            try:
                await websocket.send_text(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.websockets.discard(websocket)

    def add_websocket(self, websocket: Any) -> None:
        if len(self.websockets) >= self.settings.max_sockets_per_session:
            raise SessionError(
                f"session '{self.id}' already has the maximum "
                f"{self.settings.max_sockets_per_session} subscribers"
            )
        self.websockets.add(websocket)
        self.touch()

    def remove_websocket(self, websocket: Any) -> None:
        self.websockets.discard(websocket)

    # -- publisher (WHIP ingest) ------------------------------------------

    async def handle_publish(self, offer_sdp: str) -> str:
        if self.publisher_pc is not None:
            logger.info("[%s] replacing existing publisher", self.id)
            await self._close_publisher()

        pc = RTCPeerConnection(configuration=self._ice_configuration())
        self.publisher_pc = pc

        @pc.on("connectionstatechange")
        async def on_connection_state_change() -> None:
            logger.info("[%s] publisher connection: %s", self.id, pc.connectionState)
            await self.broadcast(
                {"type": "status", "session_id": self.id, "publisher": pc.connectionState}
            )
            if pc.connectionState in ("failed", "closed"):
                await self._close_publisher()

        @pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            logger.info("[%s] inbound %s track", self.id, track.kind)
            self.attach_track(track)

            @track.on("ended")
            async def on_ended() -> None:
                logger.info("[%s] %s track ended", self.id, track.kind)
                if track.kind == "video":
                    self.video_track = None
                    self.annotated_track = None
                else:
                    self.audio_track = None

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        answer = await pc.createAnswer()
        # aiortc completes ICE gathering inside setLocalDescription, so the SDP
        # we return already carries every candidate (no trickle needed).
        await pc.setLocalDescription(answer)

        self.touch()
        await self.broadcast({"type": "status", "session_id": self.id, "publisher": "connecting"})
        return pc.localDescription.sdp

    async def _consume_video(self, feed: MediaStreamTrack) -> None:
        while True:
            try:
                frame = await feed.recv()
            except Exception:
                logger.info("[%s] video consumer stopped", self.id)
                return

            self.touch()
            # Skip the (non-trivial) colour conversion when the engine is busy.
            if not self.engine.wants_frame():
                continue
            try:
                image = frame.to_ndarray(format="bgr24")
            except Exception:
                logger.debug("[%s] frame conversion failed", self.id, exc_info=True)
                continue
            self.engine.submit(image, time.monotonic())

    async def _consume_audio(self, feed: MediaStreamTrack) -> None:
        counter = 0
        while True:
            try:
                frame = await feed.recv()
            except Exception:
                logger.info("[%s] audio consumer stopped", self.id)
                return

            counter += 1
            # Opus delivers 20 ms frames; metering every 5th gives ~10 Hz.
            if counter % 5:
                continue
            try:
                samples = frame.to_ndarray().astype(np.float32)
            except Exception:
                continue
            if samples.size == 0:
                continue
            rms = float(np.sqrt(np.mean(np.square(samples))) / 32768.0)
            self.engine.submit_audio_level(min(1.0, rms))

    def attach_track(self, track: MediaStreamTrack) -> None:
        """Wire an inbound track into the ingress relay.

        Shared by both sources -- a WebRTC publisher and a server-side
        MediaPlayer -- so the media graph downstream of this point is identical
        no matter where the pixels came from.
        """
        if track.kind == "video":
            self.video_track = track
            inference_feed = self.ingress.subscribe(track, buffered=False)
            render_feed = self.ingress.subscribe(track, buffered=False)
            self.annotated_track = AnnotatedVideoTrack(render_feed, self)
            self._spawn(self._consume_video(inference_feed), f"video-{self.id}")
        elif track.kind == "audio":
            self.audio_track = track
            meter_feed = self.ingress.subscribe(track, buffered=False)
            self._spawn(self._consume_audio(meter_feed), f"audio-{self.id}")

    # -- server-side ingest (RTSP / HTTP / file) --------------------------

    async def _validate_ingest_url(self, url: str) -> str:
        """Scheme allowlist + SSRF address policy. See utils/security.py."""
        if not self.settings.ingest_enabled:
            raise SessionError("server-side ingest is disabled (INGEST_ENABLED=0)")

        allowed = {
            part.strip().lower()
            for part in self.settings.ingest_allowed_schemes.split(",")
            if part.strip()
        }
        if not allowed:
            raise SessionError("no ingest schemes are permitted")

        try:
            return await validate_ingest_url(
                url,
                allowed_schemes=allowed,
                allow_private=self.settings.ingest_allow_private,
                resolve_timeout=min(5.0, self.settings.ingest_timeout_s),
            )
        except UrlNotAllowed as exc:
            raise SessionError(str(exc)) from exc

    async def start_ingest(
        self,
        url: str,
        *,
        loop_file: bool = False,
        rtsp_transport: str = "tcp",
        audio: bool = True,
        format_hint: str | None = None,
        width: int | None = None,
        height: int | None = None,
        fps: int | None = None,
    ) -> dict[str, Any]:
        """Pull a stream from `url` and feed it through the same pipeline."""
        url = await self._validate_ingest_url(url)
        await self._close_publisher()

        # `device:///dev/video0` -> a local capture device. ffmpeg's v4l2 demuxer
        # takes a bare device path, not a URL, so the scheme is stripped here.
        # Keeping a scheme in the public form is deliberate: `_validate_ingest_url`
        # rejects schemeless input, which is what stops this endpoint being a
        # blind file/SSRF primitive.
        target = url
        if url.startswith("device://"):
            target = url[len("device://") :] or "/dev/video0"
            format_hint = format_hint or ("v4l2" if os.name != "nt" else "dshow")

        options: dict[str, str] = {
            # UDP RTSP silently loses packets behind NAT and produces a stream
            # that decodes into green smears; TCP is the safe default.
            "rtsp_transport": rtsp_transport,
            "stimeout": str(int(self.settings.ingest_timeout_s * 1_000_000)),
            # Never let ffmpeg build a multi-second buffer: this pipeline is
            # explicitly latest-frame-wins, and a deep buffer defeats that.
            "fflags": "nobuffer",
            "flags": "low_delay",
            "max_delay": "500000",
            # Containment for the ffmpeg side of the SSRF surface: an HTTP
            # redirect must not be able to escape the scheme policy we just
            # enforced, and it must not be able to reach file://.
            "protocol_whitelist": "file,crypto,data,rtp,udp,tcp,tls,https,http,rtsp,rtmp",
            "follow_redirects": "0",
        }
        # v4l2 negotiates its mode at open time; asking for it up front avoids
        # ffmpeg picking a 5 fps MJPEG mode on cameras that offer one.
        if width and height:
            options["video_size"] = f"{int(width)}x{int(height)}"
        if fps:
            options["framerate"] = str(int(fps))

        def _open() -> MediaPlayer:
            return MediaPlayer(
                target,
                format=format_hint,
                options=options,
                timeout=self.settings.ingest_timeout_s,
                loop=loop_file,
            )

        try:
            # MediaPlayer's constructor blocks until the stream opens, which for
            # an unreachable camera means a multi-second stall. Keep it off the
            # event loop or every other session freezes with it.
            player = await asyncio.get_running_loop().run_in_executor(
                self.runtime.executor, _open
            )
        except Exception as exc:  # noqa: BLE001
            # Full detail to the log, a generic message to the caller: ffmpeg's
            # errors carry local paths and internal hostnames, and the response
            # would otherwise be an oracle for probing the internal network.
            logger.warning("[%s] ingest failed for %s: %s", self.id, target, exc)
            raise SessionError(
                "could not open the requested source (see server logs for detail)"
            ) from exc

        if player.video is None:
            with contextlib.suppress(Exception):
                player.audio and player.audio.stop()
            raise SessionError(f"'{url}' has no video stream")

        self.ingest_player = player
        self.ingest_url = url
        self.attach_track(player.video)
        if audio and player.audio is not None:
            self.attach_track(player.audio)

        self.touch()
        logger.info("[%s] ingest started: %s", self.id, url)
        await self.broadcast(
            {"type": "status", "session_id": self.id, "publisher": "connected",
             "source": "ingest", "source_url": url}
        )
        return {"session_id": self.id, "source": "ingest", "url": url,
                "has_audio": player.audio is not None}

    async def stop_ingest(self) -> bool:
        if self.ingest_player is None:
            return False
        await self._close_publisher()
        return True

    async def stop_publisher(self) -> None:
        """Detach the publisher but keep the session (and its websockets) alive."""
        await self._close_publisher()

    async def _close_publisher(self) -> None:
        pc, self.publisher_pc = self.publisher_pc, None
        player, self.ingest_player = self.ingest_player, None
        self.ingest_url = None
        self.video_track = None
        self.audio_track = None
        self.annotated_track = None
        # New ids on the next source: reusing them across a source change would
        # claim a person walked from one camera into another.
        self.engine.reset_tracking()
        if pc is not None:
            with contextlib.suppress(Exception):
                await pc.close()
        if player is not None:
            with contextlib.suppress(Exception):
                if player.video is not None:
                    player.video.stop()
                if player.audio is not None:
                    player.audio.stop()

    # -- viewers (annotated egress) ---------------------------------------

    async def handle_watch(self, offer_sdp: str, *, annotated: bool = True) -> tuple[str, str]:  # noqa: D401
        """Attach a viewer to the egress.

        `annotated=False` hands out the untouched inbound video instead. That
        path exists mainly for server-side ingest, where the browser has no
        local copy of the source and "give me the clean feed" would otherwise be
        impossible to answer.
        """
        if self.video_track is None:
            raise SessionError(f"session '{self.id}' has no active publisher")
        if annotated and self.annotated_track is None:
            raise SessionError(f"session '{self.id}' has no annotated track")
        # Each viewer costs an encoder and a peer connection; unbounded viewers
        # are a cheap way to exhaust the CPU budget for every other session.
        if len(self.viewers) >= self.settings.max_viewers_per_session:
            raise SessionError(
                f"session '{self.id}' already has the maximum "
                f"{self.settings.max_viewers_per_session} viewers"
            )

        viewer_id = uuid.uuid4().hex[:12]
        pc = RTCPeerConnection(configuration=self._ice_configuration())
        self.viewers[viewer_id] = pc

        @pc.on("connectionstatechange")
        async def on_connection_state_change() -> None:
            logger.info("[%s] viewer %s: %s", self.id, viewer_id, pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await self.drop_viewer(viewer_id)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))

        if annotated:
            # One annotation pass feeds every viewer via the egress relay.
            pc.addTrack(self.egress.subscribe(self.annotated_track, buffered=False))
        else:
            pc.addTrack(self.ingress.subscribe(self.video_track, buffered=False))
        if self.audio_track is not None:
            pc.addTrack(self.ingress.subscribe(self.audio_track, buffered=False))

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        self.touch()
        return viewer_id, pc.localDescription.sdp

    async def drop_viewer(self, viewer_id: str) -> None:
        pc = self.viewers.pop(viewer_id, None)
        if pc is not None:
            with contextlib.suppress(Exception):
                await pc.close()

    # -- teardown ---------------------------------------------------------

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        logger.info("[%s] closing session", self.id)

        for viewer_id in list(self.viewers):
            await self.drop_viewer(viewer_id)
        await self._close_publisher()

        for task in list(self._tasks):
            task.cancel()
        for task in list(self._tasks):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

        await self.engine.stop()

        for websocket in list(self.websockets):
            with contextlib.suppress(Exception):
                await websocket.close()
        self.websockets.clear()


class SessionManager:
    def __init__(self, settings: Settings, runtime: InferenceRuntime) -> None:
        self.settings = settings
        self.runtime = runtime
        self.sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()
        self._reaper: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._reaper = asyncio.create_task(self._reap_idle(), name="session-reaper")

    async def get_or_create(self, session_id: str) -> Session:
        async with self._lock:
            session = self.sessions.get(session_id)
            if session is None:
                # Each session holds a peer connection, worker tasks and its own
                # telemetry. Without a cap, an unauthenticated caller can create
                # them in a loop until the process dies.
                if len(self.sessions) >= self.settings.max_sessions:
                    raise SessionError(
                        f"server is at its session limit ({self.settings.max_sessions})"
                    )
                session = Session(session_id, self.settings, self.runtime)
                self.sessions[session_id] = session
                logger.info("[%s] session created (%d active)", session_id, len(self.sessions))
            session.touch()
            return session

    def get(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    async def close_session(self, session_id: str) -> bool:
        async with self._lock:
            session = self.sessions.pop(session_id, None)
        if session is None:
            return False
        await session.close()
        return True

    def describe_all(self) -> list[dict[str, Any]]:
        return [session.describe() for session in self.sessions.values()]

    async def _reap_idle(self) -> None:
        """Drop sessions with no publisher, viewers or websockets."""
        timeout = self.settings.session_idle_timeout_s
        while True:
            try:
                await asyncio.sleep(10.0)
                now = time.monotonic()
                stale = [
                    session_id
                    for session_id, session in self.sessions.items()
                    if not session.has_publisher
                    and not session.viewers
                    and not session.websockets
                    and now - session.last_activity > timeout
                ]
                for session_id in stale:
                    logger.info("[%s] reaping idle session", session_id)
                    await self.close_session(session_id)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("session reaper error")

    async def shutdown(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reaper
        for session_id in list(self.sessions):
            await self.close_session(session_id)
