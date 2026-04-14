#!/usr/bin/env python3
"""
Read the version from pyproject.toml and write src/_version.h, which defines
FIRMWARE_VERSION for the firmware to embed and report.
"""

import inspect
import os
import tomllib
from typing import Any

# PlatformIO/SCons globals injected at runtime.
Import: Any
Return: Any
env: Any

Import("env")

if env.IsIntegrationDump() or env.IsCleanTarget():
    Return()

frame = inspect.currentframe()
assert frame is not None
script_name = os.path.basename(inspect.getfile(frame))
print(f"[{script_name}] Start")

with open(os.path.join(env.get("PROJECT_DIR"), "pyproject.toml"), "rb") as f:
    pyproject = tomllib.load(f)

version = pyproject["project"]["version"]

header_path = os.path.join(env.get("PROJECT_DIR"), "src", "_version.h")
with open(header_path, "w") as f:
    f.write(
        "// Generated from pyproject.toml by generate_version.py. Do not edit.\n"
        "#pragma once\n"
        f'#define FIRMWARE_VERSION "{version}"\n'
    )
print(f"[{script_name}] Wrote src/_version.h (version {version})")
