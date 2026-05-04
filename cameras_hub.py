#!/usr/bin/env python3
"""Standalone Cameras Hub server.

Serves only the hub page and its dependencies from the static/ directory next to this script.
Optionally loads a store (cameras config) file.

Usage:
    python cameras_hub.py [--port PORT] [--store FILE]
                          [--auth-user USER] [--auth-password PASS]
                          [--auth-write-user USER] [--auth-write-password PASS]

Auth configures access to the --store file:
  --auth-user / --auth-password
      Who may read the cameras store.
  --auth-write-user / --auth-write-password
      Who may write the cameras store.
      Omit to disable write access entirely.

  Specify "*" as user for open access. Specify same --auth-user and --auth-write-user,
  and password in --auth-password, to share credentials for both.

  Passwords can be literal, read from a file with @/path/to/file, read from stdin with @-,
  or prompted interactively when omitted and running in a terminal.
"""

from abc import ABC, abstractmethod
import argparse
import base64
import http.client
import json
import socket
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path

from pylib import PUBLIC_FILES, read_firmware_version, resolve_password, serve_static


_FIRMWARE_VERSION: str = read_firmware_version()

OPEN_ACCESS_USERNAME = "*"


class Auth(ABC):
    """Base class for an authentication tier."""

    @abstractmethod
    def matches(self, username: str, password: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def label(self) -> str:
        raise NotImplementedError


class AllowAllAuth(Auth):
    """Free access — matches any request."""

    def matches(self, username: str, password: str) -> bool:
        return True

    def label(self) -> str:
        return '"*" (open access)'


class CredentialsAuth(Auth):
    """Matches a specific username and password."""

    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password

    def matches(self, username: str, password: str) -> bool:
        return username == self.username and password == self.password

    def label(self) -> str:
        return self.username


DEFAULT_HUB_FILE = "hub.html"

HUB_FILES = {
    "hub.html",
    "hub.mjs",
    "page_options.mjs",
    "util.mjs",
    "hub.css",
    "style.css",
} | PUBLIC_FILES


class _Formatter(argparse.ArgumentDefaultsHelpFormatter, argparse.RawDescriptionHelpFormatter):
    pass


_EPILOG = """\
Authorization for the --store file:
  --auth-user / --auth-password
      Who may read the cameras store.
  --auth-write-user / --auth-write-password
      Who may write the cameras store.
      Omit to disable write access entirely.

  Specify "*" as user for open access. Specify same --auth-user and --auth-write-user,
  and password in --auth-password, to share credentials for both.

  Passwords can be literal, read from a file with @/path/to/file, read from stdin with @-,
  or prompted interactively when omitted and running in a terminal.

Usage examples:
  # Public read, authenticated write:
  %(prog)s --store cameras_store.json \\
           --auth-write-user admin --auth-write-password secret

  # Protected read and write, same credentials (--auth-write-password omitted — password is shared):
  %(prog)s --store cameras_store.json \\
           --auth-user admin --auth-password secret \\
           --auth-write-user admin

  # Protected read and write, separate credentials:
  %(prog)s --store cameras_store.json \\
           --auth-user viewer --auth-password viewpass \\
           --auth-write-user admin --auth-write-password adminpass

  # Public read and write (no credentials):
  %(prog)s --store cameras_store.json \\
           --auth-write-user "*"
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Standalone Cameras Hub server", epilog=_EPILOG, formatter_class=_Formatter)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--store", default=None, metavar="FILE", help="Cameras store JSON file")
    p.add_argument(
        "--auth-user",
        default=None,
        metavar="USER",
        help=f'Username with read access to the store. Use "{OPEN_ACCESS_USERNAME}" for public read.',
    )
    p.add_argument(
        "--auth-password",
        default=None,
        metavar="PASS",
        help="Read-tier password. Use @FILE to read from a file, @- for stdin. Omit to be prompted if stdin is a tty.",
    )
    p.add_argument(
        "--auth-write-user",
        default=None,
        metavar="USER",
        help=f'Username with write access: can save the store via PUT. Requires --store. Use "{OPEN_ACCESS_USERNAME}" for public write.',
    )
    p.add_argument(
        "--auth-write-password",
        default=None,
        metavar="PASS",
        help="Write-tier password. Use @FILE to read from a file, @- for stdin. Omit to be prompted if stdin is a tty.",
    )
    p.add_argument(
        "--enable-proxy",
        action="store_true",
        help=(
            "Enable the per-camera reverse proxy — open one local port per camera and forward requests. "
            "Useful when the hub is exposed via a single tunnel/VPN but the cameras are not directly reachable "
            "from outside. The client can still disable it via a toggle in the hub menu."
        ),
    )
    args = p.parse_args()

    # Both auth tiers require a store file.
    if not args.store:
        if args.auth_user:
            p.error("--auth-user requires --store")
        if args.auth_write_user:
            p.error("--auth-write-user requires --store")

    # Password is only allowed when a user is specified.
    if args.auth_password is not None:
        if args.auth_user is None:
            p.error("--auth-password requires --auth-user")
        if args.auth_user == OPEN_ACCESS_USERNAME:
            p.error(f"--auth-password cannot be used with --auth-user '{OPEN_ACCESS_USERNAME}'")
    if args.auth_write_password is not None:
        if args.auth_write_user is None:
            p.error("--auth-write-password requires --auth-write-user")
        if args.auth_write_user == OPEN_ACCESS_USERNAME:
            p.error(f"--auth-write-password cannot be used with --auth-write-user '{OPEN_ACCESS_USERNAME}'")

    # Open write implies open read — a read restriction would be bypassed anyway.
    if args.auth_write_user == OPEN_ACCESS_USERNAME and args.auth_user:
        p.error(
            f"--auth-user cannot be used when --auth-write-user is '{OPEN_ACCESS_USERNAME}' (write access already allows reads)"
        )

    # If write user matches read user, share the password — --auth-write-password is redundant.
    same_user = args.auth_user and args.auth_user == args.auth_write_user
    if same_user and args.auth_write_password is not None:
        p.error(
            "--auth-write-password must be omitted when --auth-write-user matches --auth-user (use --auth-password for both)"
        )

    return args


STORE_VERSION = 1


def load_store(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and "cameras" in data:
            return {
                "version": data.get("version", STORE_VERSION),
                "cameras": data.get("cameras", []),
                "auths": data.get("auths", []),
            }
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {"version": STORE_VERSION, "cameras": [], "auths": []}


def save_store(path: Path, store: dict[str, object]) -> None:
    if store.get("version") != STORE_VERSION:
        raise ValueError(f"Unsupported store version: {store.get('version')}")
    path.write_text(json.dumps(store, indent=2))


def extract_basic_auth(handler: BaseHTTPRequestHandler) -> tuple[str, str]:
    """Returns (username, password) from the Basic Authorization header, or ("", "") if absent/invalid."""
    header = handler.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return "", ""
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8", errors="replace")
        u, _, p = decoded.partition(":")
        return u, p
    except Exception:
        return "", ""


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ---------------------------------------------------------------------------
# Reverse proxy — one port per camera, OS-assigned. Forwards every request
# transparently so the hub page (on the main port) can fetch thumbs, status,
# and open /video /photo /ota etc. against cameras that aren't directly
# reachable by the client (single-tunnel deployments).
# ---------------------------------------------------------------------------

# Hop-by-hop headers that must not be forwarded through a proxy (RFC 7230 §6.1).
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)


class _ProxyListener(ThreadedHTTPServer):
    """ThreadedHTTPServer subclass that carries the upstream camera origin.

    `origin` is scheme://host[:port] — everything before the path. The handler
    forwards every incoming request with path+query preserved, which makes the
    proxy work for both kikker-x cameras (where cam.url is a base like
    'http://cam1') and generic cameras where cam.url is a direct capture URL
    like 'http://cam/video.cgi' — both map to the same origin.

    `connect_host` is what we actually pass to HTTPConnection: normally the
    hostname, but for .local names we resolve once at listener-creation time
    and cache the IP. This avoids re-doing an mDNS lookup per request, which
    adds latency and can time out on flaky multicast links. The `Host` header
    stays as the original hostname so the camera still sees the expected
    authority. Re-resolution on failure is handled in _forward."""

    def __init__(self, addr: tuple[str, int], handler_cls: type[BaseHTTPRequestHandler], origin: str) -> None:
        super().__init__(addr, handler_cls)
        self.origin = origin
        parsed = urllib.parse.urlsplit(origin)
        self.hostname: str = parsed.hostname or ""
        self.connect_host: str = self._initial_resolve()

    def _resolve_mdns(self) -> str | None:
        """Resolve the hostname if it ends in .local. Returns the IP, or None
        on failure (caller decides whether to log or fall back)."""
        if not self.hostname.endswith(".local"):
            return None
        try:
            return socket.gethostbyname(self.hostname)
        except OSError:
            return None

    def _initial_resolve(self) -> str:
        ip = self._resolve_mdns()
        if ip is not None:
            print(f"[proxy] cached {self.hostname} → {ip}")
            return ip
        if self.hostname.endswith(".local"):
            print(f"[proxy] could not resolve {self.hostname} (will retry per-request)")
        return self.hostname

    def refresh_resolution(self) -> None:
        """Re-run the mDNS resolve after a connection failure. Logs only when
        the address actually changed, so a flaky upstream doesn't spam the log."""
        new = self._resolve_mdns()
        if new is None or new == self.connect_host:
            return
        print(f"[proxy] re-resolved {self.hostname} → {new} (was {self.connect_host})")
        self.connect_host = new


class _ProxyHandler(BaseHTTPRequestHandler):
    # Log with a distinct prefix (and upstream origin) so proxied traffic is
    # visually separate from the main hub request log.
    def log_message(self, fmt: str, *args: object) -> None:
        server: _ProxyListener = self.server  # type: ignore[assignment]
        local_port = server.server_address[1]
        print(f"  [proxy :{local_port} → {server.origin}]  {self.address_string()} - {fmt % args}")

    def do_OPTIONS(self) -> None:
        # CORS preflight for cross-origin requests from the hub page — the hub is
        # served on its main port, the proxy on a random one, so browsers treat
        # them as different origins. Answer locally without bothering the camera.
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def setup(self) -> None:
        super().setup()
        # Disable Nagle on the client socket too — for streamed responses we
        # want each frame's data to go out as soon as we write it, not wait
        # for an ACK on the previous partial segment.
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def do_GET(self) -> None:
        self._forward()

    def do_HEAD(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def do_PUT(self) -> None:
        self._forward()

    def do_PATCH(self) -> None:
        self._forward()

    def do_DELETE(self) -> None:
        self._forward()

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        # Retry-After isn't in the CORS-safelisted response headers — expose it
        # so client JS can read it (the hub honors it on transient 503s).
        self.send_header("Access-Control-Expose-Headers", "Retry-After")

    def _forward(self) -> None:
        server: _ProxyListener = self.server  # type: ignore[assignment]
        origin = server.origin
        parsed = urllib.parse.urlsplit(origin)
        scheme = parsed.scheme or "http"
        port = parsed.port or (443 if scheme == "https" else 80)

        # The request path (from the client to our proxy port) is forwarded
        # verbatim to the upstream. This makes the proxy transparent to the
        # URL structure: kikker-x and non-kikker-x cameras work the same way.
        upstream_path = self.path

        # Forward headers minus hop-by-hop, and rewrite Host to the camera's
        # original authority (hostname:port) — even when we're connecting to a
        # cached IP for a .local name, the camera should still see the expected
        # Host header.
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            if name.lower() in _HOP_BY_HOP or name.lower() == "host":
                continue
            headers[name] = value
        headers["Host"] = parsed.netloc

        # Read the request body up front — BaseHTTPRequestHandler exposes it via self.rfile.
        body: bytes | None = None
        length = self.headers.get("Content-Length")
        if length is not None:
            try:
                n = int(length)
            except ValueError:
                n = 0
            if n > 0:
                body = self.rfile.read(n)

        conn_cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection

        def try_connect(host: str) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
            # 30s timeout guards the connect + request + response-headers phase. After
            # we have the response we drop the socket timeout so long-running MJPEG
            # streams (which may have long gaps between frames on low-fps cameras) don't
            # trip a read timeout. Client disconnect still cleans up via BrokenPipeError.
            conn = conn_cls(host, port, timeout=30)
            conn.request(self.command, upstream_path, body=body, headers=headers)
            resp = conn.getresponse()
            if conn.sock is not None:
                conn.sock.settimeout(None)
                # Disable Nagle on the upstream socket — for MJPEG the camera's last
                # partial TCP segment of each frame otherwise waits up to 200ms for an
                # ACK, gating the framerate downstream.
                try:
                    conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
            return conn, resp

        try:
            conn, resp = try_connect(server.connect_host)
        except (OSError, http.client.HTTPException):
            # For .local names: cached IP may be stale (DHCP renewed). Try a
            # fresh resolution once and retry. For non-.local, refresh_resolution
            # is a no-op.
            server.refresh_resolution()
            try:
                conn, resp = try_connect(server.connect_host)
            except (OSError, http.client.HTTPException) as e:
                self.send_response(502)
                self._send_cors_headers()
                msg = f"Proxy: upstream error contacting {origin}: {e}".encode()
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return

        try:
            # Relay status + headers. Skip hop-by-hop and any upstream CORS header
            # (we replace them unconditionally so the client origin always matches).
            self.send_response(resp.status, resp.reason)
            skip_response = _HOP_BY_HOP | {
                "access-control-allow-origin",
                "access-control-allow-headers",
                "access-control-allow-methods",
                "access-control-expose-headers",
            }
            for name, value in resp.getheaders():
                if name.lower() in skip_response:
                    continue
                self.send_header(name, value)
            self._send_cors_headers()
            self.end_headers()

            # Stream the body. read(n) returns as data arrives for streamed
            # responses (MJPEG) and blocks until Content-Length is satisfied or
            # the socket closes otherwise.
            while True:
                try:
                    chunk = resp.read(8192)
                except (OSError, http.client.HTTPException):
                    break
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # Client disconnected mid-stream (e.g. navigated away from
                    # the hub while MJPEG was streaming). Normal, not an error.
                    break
        finally:
            try:
                conn.close()
            except Exception:
                pass


def _url_origin(url: str) -> str | None:
    """Extract scheme://host[:port] from a URL. Returns None if the URL is
    malformed or not absolute (missing scheme/host). The returned origin is
    what the proxy keys by — multiple cameras on the same origin share one
    listener (and one port)."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if not parsed.scheme or not parsed.hostname:
        return None
    netloc = parsed.hostname
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return f"{parsed.scheme}://{netloc}"


class ProxyManager:
    """Maintains a per-origin reverse-proxy listener. Reconciles on store changes.

    Keyed by origin (scheme://host[:port]) rather than full camera URL so that
    two cameras on the same origin (e.g. a kikker-x base URL and a direct
    capture URL on the same device) share one listener."""

    def __init__(self) -> None:
        self._servers: dict[str, _ProxyListener] = {}
        self._lock = threading.Lock()

    def reconcile(self, camera_urls: list[str]) -> None:
        """Spawn listeners for new origins, close listeners for ones no longer present."""
        desired: set[str] = set()
        for url in camera_urls:
            origin = _url_origin(url)
            if origin is not None:
                desired.add(origin)
        with self._lock:
            # Close listeners for removed origins.
            for origin in list(self._servers.keys()):
                if origin not in desired:
                    server = self._servers.pop(origin)
                    server.shutdown()
                    server.server_close()
            # Spawn listeners for new origins.
            for origin in desired:
                if origin in self._servers:
                    continue
                server = _ProxyListener(("0.0.0.0", 0), _ProxyHandler, origin)
                port = server.server_address[1]
                thread = threading.Thread(
                    target=server.serve_forever,
                    daemon=True,
                    name=f"proxy-{port}",
                )
                thread.start()
                self._servers[origin] = server
                print(f"[proxy] {origin} → :{port}")

    def ports(self) -> dict[str, int]:
        """Returns a snapshot of {origin: local_port}."""
        with self._lock:
            return {origin: server.server_address[1] for origin, server in self._servers.items()}

    def shutdown(self) -> None:
        with self._lock:
            for server in self._servers.values():
                server.shutdown()
                server.server_close()
            self._servers.clear()


def make_handler(
    script_dir: Path,
    store_path: Path | None,
    auth_read: Auth | None,
    auth_write: Auth | None,
    proxy_manager: ProxyManager | None = None,
) -> type[BaseHTTPRequestHandler]:
    static_dir = script_dir / "static"

    class Handler(BaseHTTPRequestHandler):
        def _get_role(self) -> str:
            """Returns 'write', 'read', or 'denied'."""
            u, p = extract_basic_auth(self)
            if auth_write is not None and auth_write.matches(u, p):
                return "write"
            if auth_read is None or auth_read.matches(u, p):
                return "read"
            return "denied"

        def _deny(self) -> None:
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _serve_file(self, filename: str) -> None:
            if not serve_static(self, filename, [static_dir, script_dir]):
                self._send_error(404)

        def do_GET(self) -> None:
            path = self.path.split("?")[0]

            if path == "/hub":
                self.send_response(301)
                self.send_header("Location", "/")
                self.end_headers()
                return

            # Serve all static files without auth — page must load for the credential dialog to work.
            if not path.startswith("/api/"):
                filename = path.lstrip("/") or DEFAULT_HUB_FILE
                if filename in HUB_FILES:
                    self._serve_file(filename)
                    return
                self._send_error(404)
                return

            # /api/hub/status: always public — tells the client what capabilities are available.
            if path == "/api/hub/status":
                resp: dict = {
                    "isStandalone": True,
                    "version": _FIRMWARE_VERSION,
                    "store": {
                        "read": store_path is not None,
                        "write": auth_write is not None,
                    },
                }
                if proxy_manager is not None:
                    resp["proxy"] = {"ports": proxy_manager.ports()}
                self._send_json(200, resp)
                return

            # /api/hub/store: requires read access.
            if path == "/api/hub/store":
                if store_path is None:
                    self._send_error(404)
                    return
                role = self._get_role()
                if role == "denied":
                    self._deny()
                    return
                self._send_json(200, load_store(store_path))
                return

            self._send_error(404)

        def do_PUT(self) -> None:
            if self.path.split("?")[0] != "/api/hub/store":
                self._send_error(404)
                return
            if auth_write is None:
                self._send_json(403, {"error": "write access not configured"})
                return
            role = self._get_role()
            if role != "write":
                self._deny()
                return
            if store_path is None:
                self._send_json(405, {"error": "no store file configured"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                new_store = json.loads(body)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON"})
                return
            save_store(store_path, new_store)
            if proxy_manager is not None:
                cameras = new_store.get("cameras", []) if isinstance(new_store, dict) else []
                proxy_manager.reconcile([c.get("url", "") for c in cameras if isinstance(c, dict)])
            self._send_json(200, {"ok": True})

        def _send_json(self, status: int, data: object) -> None:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, status: int) -> None:
            self.send_response(status)
            self.end_headers()

        def log_message(self, fmt: str, *args: object) -> None:
            # Suppress the noisy repeated PWA-icon fetches — browsers request
            # these on every page load (and sometimes on heartbeat) and they
            # add nothing to the log.
            path = self.path.split("?")[0]
            if path in ("/logo.svg", "/logo.png", "/favicon.ico"):
                return
            print(f"  {self.address_string()} - {fmt % args}")

    return Handler


def _resolve_auth(user: str | None, password: str | None, tier: str) -> Auth | None:
    if user is None:
        return None
    if user == OPEN_ACCESS_USERNAME:
        return AllowAllAuth()
    return CredentialsAuth(user, resolve_password(password, user, context=tier))


def main() -> None:
    args = parse_args()

    script_dir = Path(__file__).parent
    store_path: Path | None = None
    if args.store:
        store_path = Path(args.store)
        if not store_path.exists() and not args.auth_write_user:
            print(f"Error: store file not found: {store_path}", file=sys.stderr)
            sys.exit(1)
    same_user = args.auth_write_user and args.auth_write_user == args.auth_user
    if same_user:
        auth_read = auth_write = _resolve_auth(args.auth_user, args.auth_password, "read+write")
    else:
        auth_read = _resolve_auth(args.auth_user, args.auth_password, "read")
        auth_write = _resolve_auth(args.auth_write_user, args.auth_write_password, "write")

    proxy_manager: ProxyManager | None = None
    if args.enable_proxy:
        proxy_manager = ProxyManager()
        if store_path is not None and store_path.exists():
            initial = load_store(store_path)
            raw_cameras = initial.get("cameras") if isinstance(initial, dict) else None
            cameras = raw_cameras if isinstance(raw_cameras, list) else []
            proxy_manager.reconcile([c.get("url", "") for c in cameras if isinstance(c, dict)])

    server = ThreadedHTTPServer(
        ("", args.port),
        make_handler(
            script_dir=script_dir,
            store_path=store_path,
            auth_read=auth_read,
            auth_write=auth_write,
            proxy_manager=proxy_manager,
        ),
    )
    print(f"Cameras Hub:   http://localhost:{args.port}/")
    print(f"Store:         {store_path or '(none)'}")
    print(f"Auth (read):   {auth_read.label() if auth_read else '(default: open access)'}")
    print(f"Auth (write):  {auth_write.label() if auth_write else '(default: no access)'}")
    print(f"Proxy:         {'enabled' if proxy_manager else 'disabled'}")
    if sys.stdout.isatty():
        print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        if proxy_manager is not None:
            proxy_manager.shutdown()


if __name__ == "__main__":
    main()
