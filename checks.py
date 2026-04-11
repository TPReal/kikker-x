#!/usr/bin/env python3
import glob
import subprocess
import sys


def run(*args: str) -> None:
    subprocess.run(list(args), check=True)


PYFILES = [f for pat in ("*.py", "build_helpers/*.py", "helpers/*.py", "pylib/*.py") for f in glob.glob(pat)]

fix = "--fix" in sys.argv[1:]

print("JS / HTML / CSS (biome check)...")
run("npx", "@biomejs/biome", "check", *(["--write", "--unsafe"] if fix else []), "./src/static")

print("Python (ruff check)...")
run("uvx", "ruff", "check", *(["--fix"] if fix else []), *PYFILES)

print("Python (ruff format)...")
run("uvx", "ruff", "format", *([] if fix else ["--check"]), *PYFILES)

print("Python (mypy)...")
run("uvx", "--with", "types-requests", "mypy", *glob.glob("*.py"), "build_helpers/", "pylib/")
