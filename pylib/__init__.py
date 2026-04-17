"""Shared utilities for KikkerX scripts."""

import getpass
import sys
import tomllib
from http.server import BaseHTTPRequestHandler
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Files served without authentication on all KikkerX servers (camera, fake, hub).
# Browsers fetch these for PWA/icon support before any login prompt.
PUBLIC_FILES: frozenset[str] = frozenset({"manifest.json", "logo.svg", "logo.png"})

_MIME: dict[str, str] = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def serve_static(handler: BaseHTTPRequestHandler, filename: str, dirs: list[Path]) -> bool:
    """Serve `filename` from the first directory in `dirs` that contains it.

    Writes a 200 response with Content-Type, Content-Length, and Cache-Control: no-cache.
    Returns True if the file was found and served, False if not found in any directory.
    """
    for d in dirs:
        path = d / filename
        try:
            data = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            continue
        mime = _MIME.get(path.suffix, "application/octet-stream")
        handler.send_response(200)
        handler.send_header("Content-Type", mime)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-cache")
        handler.end_headers()
        handler.wfile.write(data)
        return True
    return False


def read_firmware_version() -> str:
    """Read the project version from pyproject.toml — used by Python servers to
    report the same FIRMWARE_VERSION string that the C++ firmware embeds."""
    with (_PROJECT_ROOT / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)["project"]["version"]


def resolve_password(arg: str | None, username: str, context: str = "") -> str:
    """
    Resolve an --auth-password CLI argument.

      @FILE  → read from file (whitespace-stripped)
      @-     → read one line from stdin
      None   → prompt on terminal if stdin is a tty, otherwise error
      other  → use as-is

    context is appended to the tty prompt, e.g. "read" → "Password for admin (read): ".
    """
    if arg is None:
        if sys.stdin.isatty():
            suffix = f" ({context})" if context else ""
            return getpass.getpass(f"Password for {username}{suffix}: ")
        sys.exit("Error: --auth-password is required when stdin is not a tty")
    if arg.startswith("@"):
        source = arg[1:]
        if source == "-":
            line = sys.stdin.readline()
            if not line:
                sys.exit("Error: stdin reached EOF before a password was read")
            return line.rstrip("\n")
        return Path(source).read_text().strip()
    return arg
