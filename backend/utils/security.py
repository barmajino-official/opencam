"""Request authentication and SSRF protection.

Two independent concerns live here because both are policy rather than
mechanism, and both need to be testable without standing up the whole app.

AUTHENTICATION
    Optional bearer-token gate. Off by default so the local dev flow keeps
    working, but the moment `OPENCAM_API_TOKEN` is set every `/api/*` route and
    the metadata websocket require it. Browsers cannot set headers on a
    WebSocket handshake, so a `?token=` query parameter is accepted as well --
    that is a deliberate trade-off, and it is why tokens should be treated as
    session-scoped secrets rather than long-lived credentials.

SSRF
    `/api/ingest` hands a URL to ffmpeg, which will happily open it. Without a
    guard that is a server-side request forgery primitive: an attacker who can
    reach the API can make the backend fetch `http://169.254.169.254/...`
    (cloud instance metadata, often including credentials), probe `127.0.0.1`
    for services that trust loopback, or sweep the private network -- and read
    the outcome through timing and error messages.

    The guard resolves the hostname and rejects the request if *any* resolved
    address is loopback, private, link-local, multicast or otherwise reserved.
    Every address is checked, not just the first, because a hostname with both
    a public and a private A record would otherwise slip through.

    This is defence in depth, not a proof. It cannot close the TOCTOU window
    between our resolution and ffmpeg's, and it cannot follow an HTTP redirect
    that lands somewhere private -- `protocol_whitelist` and disabled redirects
    are set on the ffmpeg side for that. The real control for a hostile network
    is `INGEST_ENABLED=0`.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import logging
import socket
import urllib.parse

logger = logging.getLogger(__name__)


class AuthError(Exception):
    """Raised when a request presents a missing or invalid token."""


class UrlNotAllowed(Exception):
    """Raised when an ingest URL fails policy checks."""


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------


def token_matches(expected: str, presented: str | None) -> bool:
    """Constant-time token comparison.

    `hmac.compare_digest` rather than `==`: a short-circuiting comparison leaks
    the length of the shared prefix through timing, which is enough to recover
    a token byte by byte over many requests.
    """
    if not presented:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), presented.encode("utf-8"))


def extract_token(auth_header: str | None, query_token: str | None) -> str | None:
    """Pull a bearer token from the Authorization header, else the query."""
    if auth_header:
        scheme, _, value = auth_header.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
    return query_token


# --------------------------------------------------------------------------
# SSRF guard
# --------------------------------------------------------------------------

# Schemes that never touch the network and so bypass the address checks. They
# are dangerous for a different reason (arbitrary local file / device read), so
# neither is in the default allowlist.
LOCAL_SCHEMES = {"file", "device"}


def _is_blocked_address(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Return a reason string when this address must not be fetched."""
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        # 169.254.169.254 is the cloud metadata endpoint on AWS/GCP/Azure.
        return "link-local (cloud metadata range)"
    if ip.is_private:
        return "private network"
    if ip.is_multicast:
        return "multicast"
    if ip.is_reserved or ip.is_unspecified:
        return "reserved"
    # IPv4-mapped IPv6 (::ffff:127.0.0.1) would otherwise dodge every check.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _is_blocked_address(mapped)
    return None


async def resolve_and_check(host: str, port: int | None, timeout: float = 5.0) -> list[str]:
    """Resolve `host` and reject if any address is in a blocked range.

    Resolution goes through the event loop's resolver with a hard timeout.
    `socket.getaddrinfo` is a BLOCKING call: invoking it directly from a request
    handler stalls the whole event loop for as long as the resolver takes, and
    on a host without working DNS that is 30+ seconds during which no other
    request, websocket or media task is serviced -- a trivially reachable
    denial of service.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(host, port, proto=socket.IPPROTO_TCP), timeout=timeout
        )
    except asyncio.TimeoutError as exc:
        raise UrlNotAllowed(f"timed out resolving host '{host}'") from exc
    except (socket.gaierror, OSError) as exc:
        raise UrlNotAllowed(f"could not resolve host '{host}'") from exc

    addresses = sorted({str(info[4][0]) for info in infos})
    if not addresses:
        raise UrlNotAllowed(f"could not resolve host '{host}'")

    for address in addresses:
        try:
            ip = ipaddress.ip_address(address.split("%")[0])
        except ValueError:
            raise UrlNotAllowed(f"unparseable address for '{host}'") from None
        reason = _is_blocked_address(ip)
        if reason is not None:
            # Every resolved address is checked: a hostname answering with both
            # a public and a private record must not be usable as a bypass.
            raise UrlNotAllowed(
                f"host '{host}' resolves to a {reason} address and is not permitted"
            )
    return addresses


async def validate_ingest_url(
    url: str,
    *,
    allowed_schemes: set[str],
    allow_private: bool,
    resolve_timeout: float = 5.0,
) -> str:
    """Full policy check for an ingest URL. Returns the URL, or raises."""
    url = url.strip()
    if not url:
        raise UrlNotAllowed("ingest url is required")
    if len(url) > 2048:
        raise UrlNotAllowed("ingest url is too long")
    if any(ch in url for ch in ("\r", "\n", "\x00")):
        # Header/argument injection into ffmpeg's own parsing.
        raise UrlNotAllowed("ingest url contains control characters")

    parsed = urllib.parse.urlparse(url)
    scheme = parsed.scheme.lower()
    if not scheme:
        raise UrlNotAllowed("ingest url must include a scheme (rtsp://, https://, ...)")
    if scheme not in allowed_schemes:
        raise UrlNotAllowed(
            f"scheme '{scheme}' is not permitted "
            f"(INGEST_ALLOWED_SCHEMES={sorted(allowed_schemes)})"
        )

    if scheme in LOCAL_SCHEMES:
        # Explicitly opted into by the operator; there is no host to check.
        return url

    if not parsed.hostname:
        raise UrlNotAllowed("ingest url must include a host")

    if not allow_private:
        await resolve_and_check(parsed.hostname, parsed.port, timeout=resolve_timeout)
    return url
