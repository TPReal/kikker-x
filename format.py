#!/usr/bin/env python3
import glob
import subprocess
from pathlib import Path


def run(*args: str) -> None:
    subprocess.run(list(args), check=True)


PYFILES = [f for pat in ("*.py", "build_helpers/*.py", "helpers/*.py", "pylib/*.py") for f in glob.glob(pat)]

print("C++ (clang-format)...")
cpp_files = [str(p) for p in Path("src").rglob("*") if p.suffix in (".cpp", ".h")]
if cpp_files:
    run("clang-format", "-i", *cpp_files)

print("JS / HTML / CSS (biome check --write)...")
run("npx", "@biomejs/biome", "check", "--write", "./static")

print("Python (ruff format)...")
run("uvx", "ruff", "format", *PYFILES)

print("Markdown (prettier)...")
run("npx", "prettier", "--write", "**/*.md", "--print-width", "120", "--prose-wrap", "always")
