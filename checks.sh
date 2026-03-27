#!/bin/bash
set -e

echo "JS / HTML / CSS (biome lint)..."
npx @biomejs/biome lint ./src/static

echo "Python (ruff check)..."
uvx ruff check .

echo "Python (mypy)..."
uvx --with types-requests mypy *.py build_helpers/
