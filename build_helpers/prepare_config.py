#!/usr/bin/env python3
"""
Prepare the merged config for the firmware by reading and merging all JSON files specified
in the PlatformIO environment variable "custom_config_files" (a newline-separated list of paths).

The config policy (custom_config_policy) controls how the firmware uses the config at runtime:
  USE_EMBEDDED           — Use embedded config, don't touch NVS.
  STORE_EMBEDDED         — Use embedded config, save to NVS.
  LOAD_OR_USE_EMBEDDED   — Try NVS, fall back to embedded config.
  LOAD_OR_STORE_EMBEDDED — Try NVS, fall back to embedded config + save.
  LOAD_OR_USE_DEFAULT    — Try NVS, fall back to firmware defaults.
  LOAD_OR_FAIL           — Try NVS, shut down if unavailable.
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

POLICIES = [
    "USE_EMBEDDED",
    "STORE_EMBEDDED",
    "LOAD_OR_USE_EMBEDDED",
    "LOAD_OR_STORE_EMBEDDED",
    "LOAD_OR_USE_DEFAULT",
    "LOAD_OR_FAIL",
]

# Policies that don't embed any config (the binary carries no secrets).
NO_CONFIG_POLICIES = {"LOAD_OR_USE_DEFAULT", "LOAD_OR_FAIL"}

# Read and validate the config policy.
policy = env.GetProjectOption("custom_config_policy", "USE_EMBEDDED")
if policy not in POLICIES:
    print(f"[{script_name}] Unknown custom_config_policy: {policy!r}")
    print(f"[{script_name}] Valid policies: {', '.join(POLICIES)}")
    Exit(1)
policy_index = POLICIES.index(policy)
env.Append(CPPDEFINES=[("CONFIG_POLICY", policy_index)])
print(f"[{script_name}] Policy: {policy} (={policy_index})")

dst_path = os.path.join(env.get("PROJECT_SRC_DIR"), "_config.json")

if policy in NO_CONFIG_POLICIES:
    # No embedded config — write an empty file (INCBIN still needs the file to exist).
    raw_files = env.GetProjectOption("custom_config_files", "")
    config_files = [f.strip() for f in raw_files.split("\n") if f.strip()]
    if config_files:
        print(f"[{script_name}] Warning: custom_config_files ignored with {policy} policy")
    content = ""
else:
    # Read custom_config_files from the PlatformIO environment.
    raw_files = env.GetProjectOption("custom_config_files", "")
    config_files = [f.strip() for f in raw_files.split("\n") if f.strip()]
    if not config_files:
        print(f"[{script_name}] No custom_config_files specified!")
        Exit(1)

    # Shallow-merge config files in order (later files overwrite earlier top-level keys).
    merged: dict[str, Any] = {}
    for config_file in config_files:
        src_path = os.path.normpath(os.path.join(env.get("PROJECT_DIR"), config_file))
        if not os.path.isfile(src_path):
            print(f"[{script_name}] Config file {src_path} not found!")
            Exit(1)
        with open(src_path, "r", encoding="utf-8") as f:
            merged |= json.load(f)
        print(f"[{script_name}] Merged {src_path}")
    content = json.dumps(merged, separators=(",", ":"))

# Skip the write when content is unchanged — avoids mtime bumps that would
# invalidate the build cache on every run.
existing = None
if os.path.exists(dst_path):
    with open(dst_path, "r", encoding="utf-8") as f:
        existing = f.read()
if existing == content:
    print(f"[{script_name}] {dst_path} already up to date")
else:
    with open(dst_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[{script_name}] Wrote {dst_path}")
