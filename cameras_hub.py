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
import json
import sys
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


def make_handler(
    script_dir: Path,
    store_path: Path | None,
    auth_read: Auth | None,
    auth_write: Auth | None,
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
            print(f"  {self.address_string()} - {fmt % args}")

    return Handler


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


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
    server = ThreadedHTTPServer(
        ("", args.port),
        make_handler(
            script_dir=script_dir,
            store_path=store_path,
            auth_read=auth_read,
            auth_write=auth_write,
        ),
    )
    print(f"Cameras Hub:   http://localhost:{args.port}/")
    print(f"Store:         {store_path or '(none)'}")
    print(f"Auth (read):   {auth_read.label() if auth_read else '(default: open access)'}")
    print(f"Auth (write):  {auth_write.label() if auth_write else '(default: no access)'}")
    if sys.stdout.isatty():
        print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
