#!/usr/bin/env python3
"""
Prepare the merged config for the firmware by reading and merging all JSON files specified
in the PlatformIO environment variable "custom_config_files" (a newline-separated list of paths).
"""

import inspect
import os
import json
from typing import Any

# PlatformIO/SCons globals injected at runtime.
Import: Any
Return: Any
Exit: Any
env: Any

Import("env")

if env.IsIntegrationDump() or env.IsCleanTarget():
    Return()

frame = inspect.currentframe()
assert frame is not None
script_name = os.path.basename(inspect.getfile(frame))
print(f"[{script_name}] Start")

# Read custom_config_files from the PlatformIO environment.
raw_files = env.GetProjectOption("custom_config_files", "")
config_files = [f.strip() for f in raw_files.split("\n") if f.strip()]
if not config_files:
    print(f"[{script_name}] No custom_config_files specified!")
    Exit(1)

# Shallow-merge config files in order (later files overwrite top-level keys).
merged: dict[str, Any] = {}
for config_file in config_files:
    src_path = os.path.normpath(os.path.join(env.get("PROJECT_DIR"), config_file))
    if not os.path.isfile(src_path):
        print(f"[{script_name}] Config file {src_path} not found!")
        Exit(1)
    with open(src_path, "r", encoding="utf-8") as f:
        merged |= json.load(f)
    print(f"[{script_name}] Merged {src_path}")

dst_path = os.path.join(env.get("PROJECT_SRC_DIR"), "_config.json")
with open(dst_path, "w", encoding="utf-8") as f:
    json.dump(merged, f, indent=2)
print(f"[{script_name}] Wrote {dst_path}")
