#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["cairosvg"]
# ///
"""Generate logo.png from logo.svg at 192×192.

Run this whenever logo.svg changes, then commit logo.png.
"""

from pathlib import Path

import cairosvg

SIZE = 192
project_dir = Path(__file__).parent.parent
svg_path = project_dir / "logo.svg"
out_path = project_dir / "logo.png"
out_path.write_bytes(cairosvg.svg2png(bytestring=svg_path.read_bytes(), output_width=SIZE, output_height=SIZE))
print(f"Wrote {out_path} ({SIZE}×{SIZE})")
