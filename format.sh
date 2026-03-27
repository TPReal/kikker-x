#!/bin/bash
set -e

echo "C++ (clang-format)..."
find src -name '*.cpp' -o -name '*.h' | xargs clang-format -i

echo "JS / HTML / CSS (biome)..."
npx @biomejs/biome format --write ./src/static

echo "Python (ruff)..."
uvx ruff format *.py build_helpers/*.py

echo "Markdown (prettier)..."
npx prettier --write "**/*.md" --print-width 120 --prose-wrap always
