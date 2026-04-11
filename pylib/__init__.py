"""Shared utilities for KikkerX scripts."""

import getpass
import sys
from pathlib import Path

# Files served without authentication on all KikkerX servers (camera, fake, hub).
# Browsers fetch these for PWA/icon support before any login prompt.
PUBLIC_FILES: frozenset[str] = frozenset({"manifest.json", "logo.svg", "logo.png"})


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
