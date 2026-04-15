#!/usr/bin/env python3
"""
Post-link script: replace absolute paths in the firmware ELF with short placeholders
before esptool's elf2image step. That way the resulting .bin inherits correct XOR
checksum and SHA-256 without us having to recompute them.

Precompiled ESP-IDF libraries (.a files) contain __FILE__ strings baked in at Espressif's
build time that expand to the local user's path once linked. Since these are already compiled,
-fmacro-prefix-map cannot help. This script patches the final .elf by overwriting path prefixes
with a short replacement, null-padded to keep section layout intact.
"""

import inspect
import os
import re
import time
from typing import Any

Import: Any
Return: Any
env: Any

Import("env")

if env.IsIntegrationDump() or env.IsCleanTarget():
    Return()

frame = inspect.currentframe()
assert frame is not None
script_name = os.path.basename(inspect.getfile(frame))


# Regex is used only to locate the FIRST match, which gives us the exact prefix
# (drive letter + username + packages dir) used for this build. After that we
# switch to bytes.find(prefix) — Boyer–Moore is orders of magnitude faster than
# the regex engine over a ~14 MB ELF.
_PATTERN = re.compile(rb"[A-Z]:[/\\]Users[/\\][^/\\\x00]+[/\\]\.platformio[/\\]packages[/\\]")
_PREFIX_REPL = b"<pkg>/"


def strip_paths(source: Any, target: Any, env: Any) -> None:
    print(f"[{script_name}] Start")
    start = time.perf_counter()
    elf_path = target[0].get_abspath()
    with open(elf_path, "rb") as f:
        data = bytearray(f.read())

    count = _strip(data)
    if count:
        with open(elf_path, "wb") as f:
            f.write(data)

    elapsed_ms = (time.perf_counter() - start) * 1000
    name = os.path.basename(elf_path)
    print(f"[{script_name}] Stripped {count} path(s) in {name} ({elapsed_ms:.0f} ms)")


def _strip(data: bytearray) -> int:
    """Replace <prefix><suffix>\\0 runs with <pkg>/<suffix>\\0…\\0 in place.

    Each path is NUL-terminated in .rodata / .debug_str; we preserve the terminator
    and null-pad the freed prefix bytes so section offsets don't shift.
    """
    m = _PATTERN.search(data)
    if m is None:
        return 0
    prefix = m.group(0)
    prefix_len = len(prefix)
    padding = bytes(prefix_len - len(_PREFIX_REPL))

    pos = 0
    count = 0
    while True:
        idx = data.find(prefix, pos)
        if idx < 0:
            break
        nul = data.find(b"\x00", idx + prefix_len)
        if nul < 0:
            nul = len(data)
        # Length-preserving in-place rewrite of [idx:nul]:
        #   <prefix><suffix>  →  <repl><suffix><zero_pad>
        # CPython's bytearray slice assignment takes the fast memmove path when lengths match.
        data[idx:nul] = _PREFIX_REPL + bytes(data[idx + prefix_len : nul]) + padding
        pos = nul
        count += 1
    return count


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", strip_paths)
print(f"[{script_name}] Registered the post-link action")
