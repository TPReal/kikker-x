#!/usr/bin/env -S uv run
"""
fake_server.py — KikkerX development HTTP server.

Serves static/ files directly — re-read on every request so edits take effect on browser reload.

Usage:
    ./fake_server.py [--port PORT] [--board BOARD]

    --port PORT     Port to listen on (default: 8080)
    --board BOARD   Simulate a specific board's feature set:
                      timercam  — LED + battery enabled (default)
                      wrovercam — LED + battery disabled
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import random
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import Any
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from pylib import PUBLIC_FILES, read_firmware_version, serve_static
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

# ---------------------------------------------------------------------------
# Board feature table
# ---------------------------------------------------------------------------

_BOARD_FEATURES: dict[str, dict[str, Any]] = {
    "timercam": {"board": "M5Stack Timer Camera X", "led": True, "battery": True},
    "wrovercam": {"board": "ESP32-WROVER-CAM", "led": True, "battery": False},
}

# Populated at startup from --board argument; defaults to all features enabled.
_features: dict[str, Any] = {"board": "KikkerX (dev server)", "led": True, "battery": True}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(SCRIPT_DIR, "static")

_FIRMWARE_VERSION: str = read_firmware_version()

# ---------------------------------------------------------------------------
# config.json loader
# ---------------------------------------------------------------------------


_DEVICE_ID = "c0ffeefacade"

# Must match CONFIG_SCHEMA_VERSION in src/config.h.
_CONFIG_SCHEMA_VERSION = 2

# Simulated policy — LOAD_OR_USE_EMBEDDED so the stored entry is treated as the
# live read source and the stored-config edit endpoints are enabled (can_edit_stored).
_CONFIG_POLICY = "LOAD_OR_USE_EMBEDDED"

# Firmware defaults — mirror what Config("{}") would produce on the device.
_DEFAULT_CONFIG: dict[str, Any] = {
    "mdns": None,
    "known_networks": [],
    "fallback_access_point": {"ssid": "KikkerX", "password": "RANDOM"},
    "allow_cors": True,
    "auth": None,
    "allow_ota": True,
}

# Fake "stored" config (already defaults-merged) — pretends a previous install
# put this in NVS. Shown on /api/config for realistic stored-vs-embedded diffs,
# but not used by any other endpoint.
#
# `None` emulates an empty / absent NVS entry (e.g. after DELETE /api/config/stored).
_stored_config: dict[str, Any] | None = {
    **_DEFAULT_CONFIG,
    "mdns": "camera-kitchen",
    "known_networks": [
        {"ssid": "Network", "password": "pass"},
    ],
    "fallback_access_point": False,
    "allow_cors": True,
    "auth": {
        "username": "admin",
        "password_sha256": "b0c4f8a9e2d5ab3cc1769c2b4ef0f1e8d4a55eeb6b1c2d3e4f5061728394a5b6",
    },
    "allow_ota": False,
}


def get_active_config() -> dict[str, Any]:
    """Load src/_config.json fresh on every call (or {} if missing), then
    shallow-merge with firmware defaults. No caching — behaves like the
    statics, so edits take effect on reload."""
    built_config = os.path.join(SCRIPT_DIR, "src", "_config.json")
    try:
        with open(built_config, "r", encoding="utf-8") as f:
            text = f.read().strip()
        # prepare_config.py writes an empty file for NO_CONFIG_POLICIES
        # (LOAD_OR_USE_DEFAULT, LOAD_OR_FAIL) — treat same as missing.
        embedded = json.loads(text) if text else {}
    except FileNotFoundError:
        embedded = {}
    return {**_DEFAULT_CONFIG, **embedded}


# Snapshot of the active config taken at boot — emulates the device's in-RAM
# "active" config that keeps running even after NVS is mutated. Mirrors
# LOAD_OR_USE_EMBEDDED: stored wins when present, else embedded.
_ACTIVE_CONFIG: dict[str, Any] = dict(_stored_config) if _stored_config else get_active_config()

# Flipped true after a successful PUT/DELETE on /api/config/stored — signals that
# NVS no longer matches what's running. Resets only on process restart.
_stored_is_modified = False


def _config_to_json(cfg: dict[str, Any]) -> dict[str, Any]:
    """Build a redacted copy of the config: keys starting with 'password' that
    hold a non-empty string are replaced with '***'. Null / empty values are
    kept verbatim (open networks have no password to hide)."""

    def redact(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {
                k: "***" if k.startswith("password") and isinstance(v, str) and v else redact(v) for k, v in obj.items()
            }
        if isinstance(obj, list):
            return [redact(v) for v in obj]
        return obj

    return redact(cfg)


# ---------------------------------------------------------------------------
# Auth — read from parsed config
# ---------------------------------------------------------------------------


def _check_auth(handler: BaseHTTPRequestHandler) -> bool:
    """Returns True if the request passes Basic Auth (or auth is unconfigured)."""
    auth = get_active_config().get("auth") or {}
    username = auth.get("username")
    if username is None:
        return True
    header = handler.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8", errors="replace")
    except Exception:
        return False
    colon = decoded.find(":")
    if colon < 0:
        return False
    req_user, req_pass = decoded[:colon], decoded[colon + 1 :]
    if req_user != username:
        return False
    return hashlib.sha256(req_pass.encode()).hexdigest() == (auth.get("password_sha256") or "")


RESOLUTIONS = {
    "QQVGA": (160, 120),
    "QVGA": (320, 240),
    "CIF": (400, 296),
    "VGA": (640, 480),
    "SVGA": (800, 600),
    "XGA": (1024, 768),
    "SXGA": (1280, 1024),
    "UXGA": (1600, 1200),
}

# ---------------------------------------------------------------------------
# .h file loader — discovers files dynamically, no hardcoded catalog
# ---------------------------------------------------------------------------


_STATIC_DIRS = [Path(STATIC_DIR), Path(SCRIPT_DIR)]


# ---------------------------------------------------------------------------
# Image generation — "Kikker's Pond at Night"
# ---------------------------------------------------------------------------

_SERVER_START = time.monotonic()
_led_state = False

# Orb definitions: (base_x, base_y, size_frac, rgb, orbit_speed, phase)
_ORBS = [
    (0.30, 0.48, 0.040, (0, 210, 155), 0.333, 0.00),  # teal
    (0.68, 0.55, 0.030, (50, 220, 50), 0.250, 1.31),  # lime
    (0.50, 0.26, 0.045, (20, 130, 240), 0.417, 2.62),  # electric blue
    (0.17, 0.70, 0.025, (230, 110, 0), 0.293, 4.10),  # amber
    (0.83, 0.22, 0.030, (170, 0, 230), 0.367, 5.50),  # violet
    (0.60, 0.78, 0.022, (0, 190, 240), 0.273, 3.35),  # cyan
]


def _add_glow(img: Image.Image, cx: int, cy: int, r: int, color: tuple[int, int, int]) -> None:
    """Additively blends a soft glowing orb into img using crop-blur-paste."""
    W, H = img.size
    margin = r * 4 + 4
    x0, y0 = max(0, cx - margin), max(0, cy - margin)
    x1, y1 = min(W, cx + margin), min(H, cy + margin)
    if x1 <= x0 or y1 <= y0:
        return
    lx, ly = cx - x0, cy - y0  # local coords within patch

    def _apply_patch(patch: Image.Image, blur: float) -> None:
        nonlocal img
        patch = patch.filter(ImageFilter.GaussianBlur(radius=max(1, blur)))
        crop = img.crop((x0, y0, x1, y1))
        img.paste(ImageChops.add(crop, patch), (x0, y0))

    pw, ph = x1 - x0, y1 - y0

    # Outer diffuse halo
    halo = Image.new("RGB", (pw, ph))
    ImageDraw.Draw(halo).ellipse(
        [lx - r * 2, ly - r * 2, lx + r * 2, ly + r * 2],
        fill=(color[0] // 5, color[1] // 5, color[2] // 5),
    )
    _apply_patch(halo, r)

    # Bright inner core
    core = Image.new("RGB", (pw, ph))
    ImageDraw.Draw(core).ellipse([lx - r, ly - r, lx + r, ly + r], fill=color)
    _apply_patch(core, r // 2)

    # Sharp pinpoint centre
    dot_r = max(1, r // 4)
    bright = (min(255, color[0] + 110), min(255, color[1] + 110), min(255, color[2] + 110))
    ImageDraw.Draw(img).ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=bright)


def _make_pond_jpeg(width: int, height: int, t: float) -> bytes:
    """Returns JPEG bytes: an animated bioluminescent pond scene."""
    # ------------------------------------------------------------------ #
    # Background: deep-water gradient (black → dark teal → near-black)   #
    # Rendered at reduced size, then scaled — cheap and smooth.          #
    # ------------------------------------------------------------------ #
    BW = min(width, 96)
    BH = max(1, BW * height // width)

    bg_data: list[tuple[int, int, int]] = []
    for y in range(BH):
        fy = y / BH
        # Subtle luminous band around 35 % depth (water surface reflection)
        band = math.exp(-((fy - 0.35) ** 2) / 0.015) * 0.35
        # Slow horizontal shimmer using sine
        shimmer = 0.04 * math.sin(fy * 18 + t * 0.2)
        lum = band + shimmer
        r = int(max(0, min(255, 3 + lum * 30)))
        g = int(max(0, min(255, 18 + lum * 90 + 10 * (1 - fy))))
        b = int(max(0, min(255, 40 + lum * 80 + 20 * (1 - fy))))
        bg_data.extend([(r, g, b)] * BW)

    img = Image.new("RGB", (BW, BH))
    img.putdata(bg_data)
    img = img.resize((width, height), Image.Resampling.BILINEAR)

    # ------------------------------------------------------------------ #
    # Caustic shimmer lines across the lower half                        #
    # ------------------------------------------------------------------ #
    draw = ImageDraw.Draw(img)
    for i in range(12):
        phase = i / 12
        y_base = int((0.55 + 0.35 * phase) * height)
        amp = int(0.006 * height * (1 + math.sin(t * 0.133 + phase * 7)))
        x_step = max(1, width // 80)
        pts = []
        for x in range(0, width + x_step, x_step):
            fx = x / width
            dy = int(amp * math.sin(fx * 12 + t * 0.367 + phase * 5))
            pts.append((x, y_base + dy))
        if len(pts) >= 2:
            alpha = int(18 * (1 - phase))
            draw.line(pts, fill=(0, alpha * 4, alpha * 2), width=1)

    # ------------------------------------------------------------------ #
    # Glowing orbs                                                       #
    # ------------------------------------------------------------------ #
    for bx, by, sf, color, sp, ph in _ORBS:
        cx = int((bx + 0.055 * math.sin(t * sp + ph)) * width)
        cy = int((by + 0.038 * math.cos(t * sp * 0.8 + ph)) * height)
        r = max(3, int(sf * min(width, height)))
        _add_glow(img, cx, cy, r, color)

    # ------------------------------------------------------------------ #
    # Expanding ripple rings from centre (pond-drop effect)              #
    # ------------------------------------------------------------------ #
    draw = ImageDraw.Draw(img)
    cx0, cy0 = width // 2, int(height * 0.45)
    for i in range(7):
        phase = (t * 0.073 + i / 7) % 1.0
        rr = int(phase * min(width, height) * 0.48)
        fade = int(100 * (1 - phase) ** 2)
        if rr > 2:
            draw.ellipse(
                [cx0 - rr, cy0 - rr, cx0 + rr, cy0 + rr],
                outline=(0, min(255, fade * 3), fade),
                width=1,
            )

    # ------------------------------------------------------------------ #
    # Drifting fireflies / pollen                                        #
    # ------------------------------------------------------------------ #
    rng = random.Random(int(t * 0.133))  # advance slowly
    for _ in range(35):
        px = int(rng.random() * width)
        py = int(rng.random() * height)
        twinkle = 0.5 + 0.5 * math.sin(t * (0.333 + rng.random()) + rng.random() * 6.28)
        brt = int(80 + 140 * twinkle)
        hue = rng.random()
        fr = int(brt * (0.4 + 0.6 * math.sin(hue * 6.28 + 1.0)))
        fg = int(brt * (0.4 + 0.6 * math.sin(hue * 6.28 + 2.5)))
        fb = int(brt * (0.4 + 0.6 * math.sin(hue * 6.28 + 0.0)))
        draw.ellipse(
            [px - 1, py - 1, px + 1, py + 1],
            fill=(min(255, fr), min(255, fg), min(255, fb)),
        )

    # ------------------------------------------------------------------ #
    # HUD overlay                                                        #
    # ------------------------------------------------------------------ #
    label = f"KikkerX  {width}x{height}  {time.strftime('%H:%M:%S')}"
    draw.text((8, 8), label, fill=(180, 200, 200))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def _make_synthwave_jpeg(width: int, height: int, t: float) -> bytes:
    """Returns JPEG bytes: an animated retrowave synthwave grid scene."""
    horizon_y = int(height * 0.42)

    # ------------------------------------------------------------------ #
    # Background gradient (low-res, scaled up)                           #
    # Sky: deep blue-purple darkening upward                             #
    # Ground: dark with a warm magenta bleed near the horizon            #
    # ------------------------------------------------------------------ #
    BW = min(width, 160)
    BH = max(1, BW * height // width)
    h_frac = horizon_y / height

    bg_data: list[tuple[int, int, int]] = []
    for y in range(BH):
        fy = y / BH
        if fy < h_frac:
            sk = fy / h_frac  # top → horizon: near-black to deep indigo
            r = int(10 + 90 * sk * sk)
            g = int(4 * sk)
            b = int(52 - 12 * sk)
        else:
            gr = (fy - h_frac) / (1 - h_frac)  # 0=horizon, 1=bottom
            r = int(70 * (1 - gr) ** 1.5)
            g = 0
            b = int(22 * (1 - gr) * (1 - gr))
        bg_data.extend([(r, g, b)] * BW)

    img = Image.new("RGB", (BW, BH))
    img.putdata(bg_data)
    img = img.resize((width, height), Image.Resampling.BILINEAR)

    vp_x = width // 2

    # ------------------------------------------------------------------ #
    # Retrowave sun: gradient disc with dark horizontal stripes          #
    # ------------------------------------------------------------------ #
    sun_r = max(8, min(width, height) // 5)
    sr = int(sun_r * (1.0 + 0.025 * math.sin(t * 0.3)))
    stripe_h = max(2, sr // 7)
    draw = ImageDraw.Draw(img)
    for dy in range(-sr, sr + 1):
        sy = horizon_y + dy
        if sy < 0 or sy >= height:
            continue
        chord = int(math.sqrt(max(0, sr * sr - dy * dy)))
        if chord <= 0:
            continue
        fy = (dy + sr) / (2 * sr)  # 0=top, 1=bottom
        in_stripe = (dy > 0) and ((dy // stripe_h) % 2 == 0)
        if in_stripe:
            col = (8, 0, 20)
        else:
            col = (
                min(255, int(220 + 35 * (1 - fy))),
                int(40 + 120 * (1 - fy) ** 2),
                int(170 * (1 - fy) ** 1.5),
            )
        draw.line([(vp_x - chord, sy), (vp_x + chord, sy)], fill=col)

    _add_glow(img, vp_x, horizon_y, sr, (255, 60, 180))
    draw = ImageDraw.Draw(img)

    # ------------------------------------------------------------------ #
    # Grid: vertical fan lines radiating from vanishing point            #
    # ------------------------------------------------------------------ #
    n_vlines = 20
    for i in range(n_vlines + 1):
        fi = i / n_vlines
        bx = int(fi * width)
        fade = max(0.0, 1.0 - abs(fi - 0.5) * 1.3)
        col = (int(190 * fade), 0, int(155 * fade))
        draw.line([(vp_x, horizon_y), (bx, height - 1)], fill=col, width=1)

    # ------------------------------------------------------------------ #
    # Grid: horizontal perspective lines scrolling toward the viewer     #
    # ------------------------------------------------------------------ #
    n_hlines = 14
    scroll = (t * 0.175) % 1.0
    for i in range(n_hlines + 2):
        depth = ((i + scroll) / n_hlines) % 1.0
        if depth <= 0:
            continue
        y = int(horizon_y + (height - horizon_y) * (depth**0.55))
        if y <= horizon_y or y >= height:
            continue
        fade = depth**0.6
        draw.line(
            [(0, y), (width - 1, y)],
            fill=(0, int(210 * fade), int(150 * fade)),
            width=1,
        )

    # ------------------------------------------------------------------ #
    # Stars: fixed positions, twinkling                                  #
    # ------------------------------------------------------------------ #
    rng = random.Random(7)
    for _ in range(220):
        px = int(rng.random() * width)
        py = int(rng.random() * horizon_y)
        brt = int(80 + 175 * (0.5 + 0.5 * math.sin(t * (0.75 + rng.random() * 1.75) + rng.random() * 6.28)))
        h = rng.random()
        sc_r = min(255, int(brt * (0.75 + 0.25 * math.sin(h * 8 + 1.0))))
        sc_g = min(255, int(brt * (0.65 + 0.35 * math.cos(h * 7 + 0.5))))
        sc_b = min(255, int(brt * (0.90 + 0.10 * math.sin(h * 9 + 2.0))))
        draw.point((px, py), fill=(sc_r, sc_g, sc_b))

    # ------------------------------------------------------------------ #
    # HUD overlay                                                        #
    # ------------------------------------------------------------------ #
    label = f"KikkerX  {width}x{height}  {time.strftime('%H:%M:%S')}"
    draw.text((8, 8), label, fill=(210, 80, 255))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def _make_julia_jpeg(width: int, height: int, t: float) -> bytes:
    """
    Returns JPEG bytes: an animated Julia set fractal garden.

    c traces a circle of radius 0.7885 in the complex plane, visiting
    spirals → coral tendrils → fern fronds → snowflakes → back.
    Rendered at full output resolution via numpy vectorisation.
    """
    MAX_ITER = 100
    R_SQ = 256.0  # large escape radius improves smooth colouring

    cr = 0.7885 * math.cos(t * 0.0267)
    ci = 0.7885 * math.sin(t * 0.0267)

    # Colour cycle speed independent of the shape-morph speed.
    col_shift = t * 0.00417

    CW, CH = width, height
    zr_a, zi_a = np.meshgrid(
        np.linspace(-1.4, 1.4, CW, dtype=np.float32),
        np.linspace(-1.4 * CH / CW, 1.4 * CH / CW, CH, dtype=np.float32),
    )

    escaped_n = np.full((CH, CW), MAX_ITER, dtype=np.int32)
    escaped_mod = np.ones((CH, CW), dtype=np.float32)
    alive = np.ones((CH, CW), dtype=bool)

    for n in range(MAX_ITER):
        zr2 = zr_a * zr_a
        zi2 = zi_a * zi_a
        just_escaped = alive & (zr2 + zi2 >= R_SQ)
        escaped_n[just_escaped] = n
        escaped_mod[just_escaped] = (zr2 + zi2)[just_escaped]
        alive &= ~just_escaped
        new_zr = zr2 - zi2 + cr
        new_zi = 2.0 * zr_a * zi_a + ci
        zr_a = np.where(alive, new_zr, zr_a)
        zi_a = np.where(alive, new_zi, zi_a)
        if not alive.any():
            break

    interior = escaped_n == MAX_ITER
    log2_mod = np.log(np.maximum(escaped_mod, 1e-10)) * 1.4427
    log2_log2 = np.log(np.maximum(log2_mod, 1e-10)) * 1.4427
    smooth = np.where(interior, 0.0, escaped_n.astype(np.float32) - log2_log2)

    hue = (smooth * 0.04 + col_shift) % 1.0
    h = (hue * 6.2832).astype(np.float32)
    r_ch = np.clip(10 + 220 * np.maximum(0.0, np.sin(h + 0.00)) ** 2, 0, 255).astype(np.uint8)
    g_ch = np.clip(5 + 240 * np.maximum(0.0, np.sin(h + 2.09)) ** 2, 0, 255).astype(np.uint8)
    b_ch = np.clip(20 + 210 * np.maximum(0.0, np.sin(h + 4.19)) ** 2, 0, 255).astype(np.uint8)
    r_ch[interior] = 0
    g_ch[interior] = 8
    b_ch[interior] = 4

    img = Image.fromarray(np.stack([r_ch, g_ch, b_ch], axis=2), "RGB")

    # Additive glow — makes the bright filaments feel luminous.
    glow = img.filter(ImageFilter.GaussianBlur(radius=2))
    img = ImageChops.add(img, glow)

    draw = ImageDraw.Draw(img)
    label = f"KikkerX  {width}x{height}  {time.strftime('%H:%M:%S')}"
    draw.text((8, 8), label, fill=(160, 255, 180))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def _make_3d_jpeg(width: int, height: int, t: float) -> bytes:
    """
    Returns JPEG bytes: wireframe armillary sphere — six orbital rings + central icosahedron.

    Six great-circle rings (three cardinal + three diagonal) enclose a regular
    icosahedron at the centre.  The whole structure rotates slowly as one rigid
    body.  Edges are depth-cued: near lines are warm ivory, far lines fade to
    near-black.  A subtle bloom pass adds the impression of luminous wire.
    Runs at full output resolution — wireframe projection is orders of magnitude
    faster than the previous raymarcher.
    """
    # ------------------------------------------------------------------ #
    # Icosahedron — 12 vertices, 30 edges                                #
    # ------------------------------------------------------------------ #
    _phi = (1.0 + math.sqrt(5.0)) / 2.0
    _circ = math.sqrt(1.0 + _phi * _phi)  # circumradius of unit-edge icos
    _s = 0.82 / _circ  # scale so circumradius = 0.82
    icos_verts = [
        (0.0, _s, _s * _phi),
        (0.0, -_s, _s * _phi),
        (0.0, _s, -_s * _phi),
        (0.0, -_s, -_s * _phi),
        (_s, _s * _phi, 0.0),
        (-_s, _s * _phi, 0.0),
        (_s, -_s * _phi, 0.0),
        (-_s, -_s * _phi, 0.0),
        (_s * _phi, 0.0, _s),
        (-_s * _phi, 0.0, _s),
        (_s * _phi, 0.0, -_s),
        (-_s * _phi, 0.0, -_s),
    ]
    _edge_sq = (2.0 * _s * 1.05) ** 2  # edge-length² with 5 % tolerance
    icos_edges = [
        (i, j)
        for i in range(12)
        for j in range(i + 1, 12)
        if sum((icos_verts[i][k] - icos_verts[j][k]) ** 2 for k in range(3)) < _edge_sq
    ]

    # ------------------------------------------------------------------ #
    # Six rings: three cardinal great circles + three diagonal ones      #
    # ------------------------------------------------------------------ #
    _h = math.sqrt(2.0) / 2.0
    ring_normals = [
        (0.0, 1.0, 0.0),  # equatorial
        (1.0, 0.0, 0.0),  # meridian 1
        (0.0, 0.0, 1.0),  # meridian 2
        (_h, _h, 0.0),  # 45° between equatorial and meridian 1
        (_h, 0.0, _h),  # 45° between equatorial and meridian 2
        (0.0, _h, _h),  # 45° between meridian 1 and meridian 2
    ]
    RING_R = 1.52
    RING_SEGS = 80

    ring_segs_3d: list[tuple[tuple[float, float, float], tuple[float, float, float]]] = []  # (point_a, point_b)
    for nx, ny, nz in ring_normals:
        # Build an orthonormal basis for the ring's plane.
        if abs(nz) < 0.9:
            ux, uy, uz = -ny, nx, 0.0
        else:
            ux, uy, uz = 0.0, -nz, ny
        ul = math.sqrt(ux * ux + uy * uy + uz * uz)
        ux /= ul
        uy /= ul
        uz /= ul
        vx = ny * uz - nz * uy
        vy = nz * ux - nx * uz
        vz = nx * uy - ny * ux
        pts = [
            (
                RING_R * (math.cos(2.0 * math.pi * k / RING_SEGS) * ux + math.sin(2.0 * math.pi * k / RING_SEGS) * vx),
                RING_R * (math.cos(2.0 * math.pi * k / RING_SEGS) * uy + math.sin(2.0 * math.pi * k / RING_SEGS) * vy),
                RING_R * (math.cos(2.0 * math.pi * k / RING_SEGS) * uz + math.sin(2.0 * math.pi * k / RING_SEGS) * vz),
            )
            for k in range(RING_SEGS)
        ]
        ring_segs_3d.extend(zip(pts, pts[1:] + [pts[0]]))

    # ------------------------------------------------------------------ #
    # Global rotation — Y spin + two-frequency precession on X and Z     #
    # ------------------------------------------------------------------ #
    gy = t * 0.46
    gx = 0.30 * math.sin(t * 0.21) + 0.10 * math.sin(t * 0.33)
    gz = 0.14 * math.sin(t * 0.18) + 0.05 * math.sin(t * 0.29)
    cy, sy = math.cos(gy), math.sin(gy)
    cx, sx = math.cos(gx), math.sin(gx)
    cz, sz = math.cos(gz), math.sin(gz)

    def rotate(x: float, y: float, z: float) -> tuple[float, float, float]:
        x, z = cy * x + sy * z, -sy * x + cy * z
        y, z = cx * y - sx * z, sx * y + cx * z
        x, y = cz * x - sz * y, sz * x + cz * y
        return x, y, z

    # ------------------------------------------------------------------ #
    # Perspective projection                                             #
    # ------------------------------------------------------------------ #
    CAM_Z = 5.2  # camera sits at z = -CAM_Z looking toward +z
    FOCAL = 3.8
    W_HALF = 1.22
    H_HALF = W_HALF * height / width

    def project(x: float, y: float, z: float) -> tuple[int, int]:
        cz_cam = z + CAM_Z
        if cz_cam < 0.1:
            cz_cam = 0.1
        xs = FOCAL * x / cz_cam
        ys = FOCAL * y / cz_cam
        px = int((xs + W_HALF) / (2.0 * W_HALF) * width)
        py = int((H_HALF - ys) / (2.0 * H_HALF) * height)
        return px, py

    # ------------------------------------------------------------------ #
    # Build segment list with world-space depth for sorting + cuing      #
    # ------------------------------------------------------------------ #
    all_segs = []  # (z_avg, proj_a, proj_b, is_icos)

    for pa, pb in ring_segs_3d:
        ra = rotate(*pa)
        rb = rotate(*pb)
        all_segs.append(((ra[2] + rb[2]) * 0.5, project(*ra), project(*rb), False))

    riv = [rotate(*v) for v in icos_verts]
    for i, j in icos_edges:
        pa, pb = riv[i], riv[j]
        all_segs.append(((pa[2] + pb[2]) * 0.5, project(*pa), project(*pb), True))

    all_segs.sort(reverse=True)  # farthest first (painter's algorithm)
    Z_NEAR, Z_FAR = -RING_R, RING_R  # world-z extent of the scene

    # ------------------------------------------------------------------ #
    # Background — faint radial glow so the sphere floats in soft space  #
    # Built at low resolution and upscaled; all C-side, very fast.       #
    # ------------------------------------------------------------------ #
    _BW, _BH = 64, 48
    bg = Image.new("RGB", (_BW, _BH), (4, 4, 6))
    _bg_draw = ImageDraw.Draw(bg)
    # Warm amber centre glow — bright enough to survive the heavy blur
    _bg_draw.ellipse((_BW // 5, _BH // 5, 4 * _BW // 5, 4 * _BH // 5), fill=(105, 72, 38))
    bg = bg.filter(ImageFilter.GaussianBlur(radius=14))
    img = bg.resize((width, height), Image.Resampling.BILINEAR)

    # ------------------------------------------------------------------ #
    # Render                                                             #
    # ------------------------------------------------------------------ #
    draw = ImageDraw.Draw(img)

    for z_avg, (px0, py0), (px1, py1), is_icos in all_segs:
        # depth: 1.0 = nearest to camera, 0.0 = farthest
        depth = (Z_FAR - z_avg) / (Z_FAR - Z_NEAR)
        depth = max(0.0, min(1.0, depth))
        d2 = depth * depth
        if is_icos:
            # Icosahedron: warm amber-gold, distinct from the rings
            r = int(40 + 208 * d2)
            g = int(34 + 178 * d2)
            b = int(22 + 130 * d2)
        else:
            # Rings: cool off-white parchment
            r = int(30 + 195 * d2)
            g = int(30 + 188 * d2)
            b = int(28 + 178 * d2)
        draw.line((px0, py0, px1, py1), fill=(r, g, b))

    # ------------------------------------------------------------------ #
    # Bloom — a tinted blur blended back in to suggest glowing wire      #
    # ------------------------------------------------------------------ #
    glow = img.filter(ImageFilter.GaussianBlur(radius=2))
    img = ImageChops.add(img, ImageChops.multiply(glow, Image.new("RGB", img.size, (72, 66, 52))))

    draw = ImageDraw.Draw(img)
    draw.text((8, 8), f"KikkerX  {width}x{height}  {time.strftime('%H:%M:%S')}", fill=(138, 128, 100))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Image generation — "Aurora Borealis" (brightness = −2)
# ---------------------------------------------------------------------------

# Constellation definitions with astronomically-correct relative star positions.
# Coordinates derived from catalogued RA/Dec, centred on a reference star and
# normalised so the constellation fits roughly within ±1.
# Convention: x increases westward (right in sky view), y increases southward (down in image).
# Star tuple: (local_x, local_y, brightness 0–1, (R, G, B) colour tint).
# Lines: list of (star_index_a, star_index_b) pairs.
# cx, cy: placement as fraction of (image width, sky height); scale: fraction of image height.
_AURORA_CONSTELLATIONS: list[dict] = [
    {  # Ursa Major — Big Dipper; upper-right sky.
        # Ref star: Megrez.  Handle arcs leftward with a characteristic downward curve.
        "stars": [
            (0.98, -0.30, 0.70, (225, 230, 255)),  # Dubhe   (K-type, warm tint; pointer star)
            (1.00, -0.04, 0.65, (215, 225, 255)),  # Merak   (pointer to Polaris)
            (0.37, 0.09, 0.65, (215, 225, 255)),  # Phecda
            (0.11, -0.07, 0.55, (215, 225, 255)),  # Megrez  (faintest of the seven)
            (-0.35, -0.02, 0.75, (200, 215, 255)),  # Alioth  (brightest in Ursa Major)
            (-0.71, 0.03, 0.65, (215, 225, 255)),  # Mizar
            (-1.00, 0.30, 0.70, (215, 225, 255)),  # Alkaid  (end of handle)
        ],
        "lines": [(0, 1), (1, 2), (2, 3), (3, 0), (3, 4), (4, 5), (5, 6)],
        "cx": 0.76,
        "cy": 0.13,
        "scale": 0.13,
    },
    {  # Cassiopeia — upper-left sky (W shape).
        # Ref star: Gamma Cas (centre of W).  Schedar has a slight orange K-type tint.
        "stars": [
            (1.00, 0.07, 0.75, (205, 220, 255)),  # Caph
            (0.40, 0.27, 0.70, (255, 215, 195)),  # Schedar  (K-type, slight warm tint)
            (0.10, -0.05, 0.65, (215, 225, 255)),  # Gamma Cas
            (-0.45, -0.01, 0.65, (215, 225, 255)),  # Ruchbah
            (-1.00, -0.27, 0.60, (215, 225, 255)),  # Segin
        ],
        "lines": [(0, 1), (1, 2), (2, 3), (3, 4)],
        "cx": 0.12,
        "cy": 0.11,
        "scale": 0.11,
    },
    {  # Orion — lower-centre sky (straddles the aurora band).
        # Ref star: centroid of all seven.  Belt tilts slightly upper-right to lower-left.
        "stars": [
            (-0.60, -1.00, 0.90, (255, 155, 105)),  # Betelgeuse  (M-type red supergiant)
            (0.28, -0.88, 0.70, (205, 215, 255)),  # Bellatrix
            (-0.17, 0.09, 0.60, (210, 220, 255)),  # Alnitak   (belt, easternmost)
            (-0.04, 0.01, 0.65, (215, 225, 255)),  # Alnilam   (belt, centre)
            (0.08, -0.10, 0.55, (210, 220, 255)),  # Mintaka   (belt, westernmost)
            (0.60, 0.83, 0.90, (175, 200, 255)),  # Rigel     (B-type blue supergiant)
            (-0.38, 1.00, 0.60, (210, 220, 255)),  # Saiph
        ],
        "lines": [(0, 1), (0, 2), (1, 4), (2, 3), (3, 4), (2, 6), (4, 5)],
        "cx": 0.30,
        "cy": 0.54,
        "scale": 0.12,
    },
    {  # Lyra — compact; Vega is the 5th-brightest star in the night sky.
        # Ref star: Vega.  A small parallelogram of four stars hangs below.
        "stars": [
            (0.00, 0.00, 0.95, (215, 225, 255)),  # Vega      (A0 V, magnitude 0.0)
            (-0.56, -0.14, 0.42, (215, 225, 255)),  # Epsilon Lyrae (famous double-double)
            (-0.76, 0.30, 0.43, (215, 225, 255)),  # Delta Lyrae
            (-0.55, 0.90, 0.45, (215, 225, 255)),  # Sheliak   (Beta Lyrae)
            (-0.92, 1.02, 0.42, (215, 225, 255)),  # Sulafat   (Gamma Lyrae)
        ],
        "lines": [(0, 1), (0, 2), (1, 2), (1, 3), (2, 4), (3, 4)],
        "cx": 0.55,
        "cy": 0.34,
        "scale": 0.08,
    },
]


def _make_aurora_jpeg(width: int, height: int, t: float) -> bytes:
    """
    Returns JPEG bytes: aurora borealis with real star constellations.

    Sky: deep navy gradient to horizon.  Aurora: five overlapping curtains each
    rendered as a Gaussian stripe whose centre undulates as a sum of two
    incommensurate sines — this gives an organic, non-repeating draping look.
    Treeline silhouette (fixed-seed random pines) fills the bottom quarter.
    Star field includes Ursa Major (Big Dipper), Cassiopeia, Orion, and Lyra
    at astronomically-correct relative positions.
    """
    sky_h = int(height * 0.74)  # sky occupies the top 74 %

    # ------------------------------------------------------------------ #
    # Background: deep navy darkening upward, slight warm teal at the   #
    # horizon (atmospheric colour scatter).                              #
    # ------------------------------------------------------------------ #
    fy = np.linspace(0.0, 1.0, sky_h, dtype=np.float32)  # 0 = top, 1 = horizon
    sky = np.zeros((sky_h, width, 3), dtype=np.float32)
    sky[:, :, 0] = (2 + 8 * fy)[:, np.newaxis]
    sky[:, :, 1] = (4 + 14 * fy)[:, np.newaxis]
    sky[:, :, 2] = (15 + 25 * fy)[:, np.newaxis]

    # ------------------------------------------------------------------ #
    # Aurora curtains (fully vectorised).                                #
    # Each curtain: centre-Y per column = sum of two incommensurate      #
    # sines → organic, non-periodic draping.  Sigma also varies along x #
    # so the curtain width is uneven, like the real thing.              #
    # ------------------------------------------------------------------ #
    xs = np.linspace(0.0, 1.0, width, dtype=np.float32)  # (W,)
    ys = np.arange(sky_h, dtype=np.float32).reshape(-1, 1)  # (sky_h, 1)

    # Each row: base_y_frac, sigma_frac, (R,G,B),
    #           f1, a1, p1,  f2, a2, p2,  pulse_speed, pulse_phase
    CURTAINS = [
        (0.32, 0.040, (0, 240, 120), 3.1, 0.070, 0.00, 7.3, 0.030, 0.50, 0.42, 0.00),
        (0.24, 0.028, (100, 40, 255), 2.6, 0.055, 2.10, 5.7, 0.025, 1.30, 0.34, 2.10),
        (0.38, 0.032, (0, 200, 240), 4.4, 0.060, 4.30, 9.1, 0.022, 2.10, 0.38, 4.30),
        (0.28, 0.022, (180, 0, 220), 3.7, 0.048, 1.50, 6.4, 0.018, 0.80, 0.28, 1.50),
        (0.42, 0.018, (0, 255, 180), 5.2, 0.035, 3.20, 8.3, 0.015, 3.70, 0.46, 3.20),
    ]

    aurora = np.zeros((sky_h, width, 3), dtype=np.float32)
    for base_y_frac, sigma_frac, color, f1, a1, p1, f2, a2, p2, ps, pp in CURTAINS:
        base_y = base_y_frac * sky_h
        sigma_base = sigma_frac * sky_h
        cy = (
            base_y
            + a1 * sky_h * np.sin(f1 * math.tau * xs + t * 0.18 + p1)
            + a2 * sky_h * np.sin(f2 * math.tau * xs + t * 0.10 + p2)
        )
        sigma = np.maximum(
            sigma_base * (0.7 + 0.6 * np.sin(math.tau * 2.8 * xs + t * 0.08 + pp * 0.7)),
            sky_h * 0.008,
        )
        brightness = np.exp(-0.5 * ((ys - cy.reshape(1, -1)) / sigma.reshape(1, -1)) ** 2)
        pulse = 0.55 + 0.45 * math.sin(t * ps + pp)
        for ch, c in enumerate(color):
            aurora[:, :, ch] += brightness * (c / 255.0) * 160.0 * pulse

    # ------------------------------------------------------------------ #
    # Stars — drawn additively into sky before aurora blend, so aurora  #
    # overlays naturally (no dark-dot artefacts).  All stars drift      #
    # leftward (simulated Earth rotation, full traverse ~10 min).       #
    # Background stars: sub-pixel antialiased by splitting brightness   #
    # across the two straddled x-pixels.                                #
    # Constellation stars: soft numpy Gaussian at exact float coords    #
    # for smooth sub-pixel motion.                                      #
    # ------------------------------------------------------------------ #
    drift = (t / 600.0) % 1.0
    drift_px = drift * width

    r_scale = max(1.0, height / 480.0)

    bg_rng = random.Random(9001)
    bg_stars = [(bg_rng.random(), bg_rng.random(), bg_rng.uniform(0.2, 1.1), bg_rng.random()) for _ in range(200)]
    for x_frac, y_frac, tw_speed, tw_phase in bg_stars:
        x_exact = ((x_frac + drift) % 1.0) * width
        sy = int(y_frac * sky_h * 0.88)
        if not (0 <= sy < sky_h):
            continue
        sx0 = int(x_exact)
        frac = x_exact - sx0
        twinkle = 0.5 + 0.5 * math.sin(t * tw_speed + tw_phase * math.tau)
        brt = (25.0 + 80.0 * twinkle) * r_scale
        for s_x, w in ((sx0 % width, 1.0 - frac), ((sx0 + 1) % width, frac)):
            sky[sy, s_x, 0] += brt * w
            sky[sy, s_x, 1] += brt * w
            sky[sy, s_x, 2] += (brt + 15.0) * w  # slight blue tint
    for const in _AURORA_CONSTELLATIONS:
        cx_px = (const["cx"] * width + drift_px) % width
        cy_px = const["cy"] * sky_h
        sc = const["scale"] * height
        for lx, ly, brt_frac, color in const["stars"]:
            x_c = cx_px + lx * sc
            y_c = cy_px + ly * sc
            if not (0 <= y_c < sky_h):
                continue
            sigma = max(0.5, brt_frac * 1.6 * r_scale)
            pr = max(2, int(sigma * 3))
            xi, yi = int(x_c), int(y_c)
            for row in range(-pr, pr + 1):
                py = yi + row
                if not (0 <= py < sky_h):
                    continue
                for col in range(-pr, pr + 1):
                    px = (xi + col) % width
                    w = math.exp(-0.5 * ((xi + col - x_c) ** 2 + (py - y_c) ** 2) / sigma**2)
                    sky[py, px, 0] += color[0] * brt_frac * w * 0.9
                    sky[py, px, 1] += color[1] * brt_frac * w * 0.9
                    sky[py, px, 2] += color[2] * brt_frac * w * 0.9

    aurora_img = Image.fromarray(np.clip(aurora, 0, 255).astype(np.uint8))
    aurora_img = aurora_img.filter(ImageFilter.GaussianBlur(radius=max(1, width // 90)))
    sky = np.clip(sky + np.array(aurora_img, dtype=np.float32), 0, 255)

    # ------------------------------------------------------------------ #
    # Assemble full frame (sky + black ground) and convert to PIL        #
    # ------------------------------------------------------------------ #
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:sky_h] = sky.astype(np.uint8)
    img = Image.fromarray(frame)

    # ------------------------------------------------------------------ #
    # Treeline silhouette — fixed-seed random pine trees                 #
    # ------------------------------------------------------------------ #
    tree_rng = random.Random(31415)
    n_trees = max(12, width // 16)
    trees = [
        (
            tree_rng.random() * width,
            (0.038 + tree_rng.random() * 0.052) * height,
            (0.018 + tree_rng.random() * 0.022) * width,
        )
        for _ in range(n_trees)
    ]
    ground_base = int(height * 0.80)
    xs_arr = np.arange(width, dtype=np.float32)
    treeline = np.zeros(width, dtype=np.float32)
    for tx, th, tw in trees:
        treeline = np.maximum(treeline, th * np.maximum(0.0, 1.0 - np.abs(xs_arr - tx) / tw))

    top_ys = np.maximum(0, ground_base - treeline.astype(np.int32))
    mask = np.arange(height).reshape(-1, 1) >= top_ys.reshape(1, -1)
    img_arr = np.array(img)
    img_arr[mask] = 0
    img = Image.fromarray(img_arr)

    # ------------------------------------------------------------------ #
    # HUD                                                                #
    # ------------------------------------------------------------------ #
    draw = ImageDraw.Draw(img)
    draw.text((8, 8), f"KikkerX  {width}x{height}  {time.strftime('%H:%M:%S')}", fill=(120, 180, 160))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


# Direct mapping from OV3660 brightness value (−2 … +2) to scene function.
_SCENE_FUNCS = {
    -2: _make_aurora_jpeg,  # Aurora Borealis
    -1: _make_3d_jpeg,  # Armillary Sphere (wireframe)
    0: _make_pond_jpeg,  # Kikker's Pond at Night
    1: _make_synthwave_jpeg,  # Retrowave Grid
    2: _make_julia_jpeg,  # Fractal Garden (Julia set)
}


def make_jpeg(width: int, height: int, scene: int = 0) -> bytes:
    t = time.monotonic() - _SERVER_START
    fn = _SCENE_FUNCS.get(scene, _make_pond_jpeg)
    return fn(width, height, t)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class KikkerXHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        super().setup()

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"  {self.address_string()}  {fmt % args}")

    def end_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and get_active_config().get("allow_cors", True):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def _deny_auth(self) -> None:
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="KikkerX"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        if get_active_config().get("allow_cors", True):
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE")
            self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.lstrip("/") not in PUBLIC_FILES and not _check_auth(self):
            self._deny_auth()
            return
        path = parsed.path
        qs = parse_qs(parsed.query)

        def qp(key: str, default: str = "") -> str:
            return qs.get(key, [default])[0]

        # --- Static file routing ---
        # /         → index.html
        # /stream   → stream.html   (extensionless paths get .html appended)
        # /foo.mjs  → foo.mjs       (verbatim)
        if path == "/":
            lookup = "index.html"
        else:
            bare = path.lstrip("/")
            if "." not in bare:
                bare += ".html"
            lookup = bare

        if serve_static(self, lookup, _STATIC_DIRS):
            return

        # --- API routes ---
        if path == "/api/logs":
            self._send_text(
                "Camera init OK\n"
                "Scanning WiFi...\n"
                "Connecting to HomeNet (RSSI -52)...\n"
                "Connected: HomeNet  IP: 192.168.1.99  RSSI: -52\n"
                "Camera server ready at http://192.168.1.99/ (http://kikker-x.local/)\n"
                "GET /\n"
                "→ 200 index.html\n"
                "GET /style.css\n"
                "→ 200 style.css\n"
                "GET /logo.svg\n"
                "→ 200 logo.svg\n"
                "GET /api/status\n"
                "→ 200 status 4132mV 87% rssi=-52\n"
                "GET /api/led\n"
                "→ 200 led state=off\n"
                "GET /api/logs\n"
                "→ 200 logs 312 bytes\n"
            )

        elif path == "/api/status":
            rssi = -58 + random.randint(-3, 3)
            ssid = "FakeAP"
            voltage = (3850 + random.randint(-15, 15)) if _features["battery"] else 0
            level = 75
            mode = qp("mode", "full")
            if mode == "short_text":
                parts = [f"WiFi: {ssid} ({rssi}dB)"]
                if _features["battery"]:
                    parts.append(f"Battery: {voltage}mV ({level}%)")
                self._send_text(", ".join(parts))
            elif mode == "short":
                data: dict[str, Any] = {"wifi": {"ssid": ssid, "rssi": rssi}}
                if _features["battery"]:
                    data["battery"] = {"voltage": voltage, "level": level}
                self._send_json(data)
            else:
                data = {
                    "id": _DEVICE_ID,
                    "wifi": {"mode": "station", "ssid": ssid, "ip": "192.168.1.99", "rssi": rssi},
                    "camera": "kikker-x",
                    "version": _FIRMWARE_VERSION,
                    "config_policy": _CONFIG_POLICY,
                    "allow_ota": get_active_config()["allow_ota"],
                    "features": _features,
                }
                if _features["battery"]:
                    data["battery"] = {"voltage": voltage, "level": level}
                self._send_json(data)

        elif path == "/api/config":
            # Policy is LOAD_OR_USE_EMBEDDED: stored is the primary read source
            # when present, else embedded. After a PUT/DELETE the stored entry
            # is marked is_modified and loses its is_active flag.
            stored_present = _stored_config is not None
            stored_is_active = stored_present and not _stored_is_modified
            active_source = "stored" if stored_is_active else "embedded"
            resp: dict[str, Any] = {
                "policy": _CONFIG_POLICY,
                "active_source": active_source,
                "schema_version": _CONFIG_SCHEMA_VERSION,
                "can_edit_stored": True,
                "active": {
                    "is_active": True,
                    "schema_version": _CONFIG_SCHEMA_VERSION,
                    "config": _config_to_json(_ACTIVE_CONFIG),
                },
                "embedded": {
                    "is_active": active_source == "embedded",
                    "schema_version": _CONFIG_SCHEMA_VERSION,
                    "config": _config_to_json(get_active_config()),
                },
                "default": {
                    "is_active": False,
                    "schema_version": _CONFIG_SCHEMA_VERSION,
                    "config": _config_to_json(_DEFAULT_CONFIG),
                },
            }
            # Mirror the device: stored is emitted even when logically empty
            # if it was just modified (distinguishes deleted from never-existed).
            if stored_present or _stored_is_modified:
                resp["stored"] = {
                    "is_active": stored_is_active,
                    "is_modified": _stored_is_modified,
                    "schema_version": _CONFIG_SCHEMA_VERSION if stored_present else 0,
                    "config": _config_to_json(_stored_config) if _stored_config is not None else None,
                }
            else:
                resp["stored"] = None
            self._send_json(resp)

        elif path == "/api/hub/status":
            self._send_json({"isStandalone": False, "store": {"read": True}})

        elif path == "/api/hub/store":
            # "SELF" is a self-reference marker: replaced by the hub with window.location.origin.
            auth_user = (get_active_config().get("auth") or {}).get("username")
            auth_id = f"auth-{_DEVICE_ID}"
            self._send_json(
                {
                    "version": 1,
                    "cameras": [{"url": "SELF", "type": "kikker-x", **({"authId": auth_id} if auth_user else {})}],
                    "auths": [{"id": auth_id, "username": auth_user}] if auth_user else [],
                }
            )

        elif path == "/api/led":
            if not _features["led"]:
                self.send_error(404)
                return
            self._send_json({"state": _led_state})

        elif path == "/api/streamfps":
            self._send_json({"fps": 18.5, "active": True})

        elif path == "/api/cam/capture.jpg":
            w, h = RESOLUTIONS.get(qp("res", "UXGA").upper(), (1600, 1200))
            jpeg = make_jpeg(w, h, int(qp("brightness", "0")))
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(jpeg)

        elif path == "/api/cam/stream.mjpeg":
            w, h = RESOLUTIONS.get(qp("res", "VGA").upper(), (640, 480))
            self._serve_mjpeg(w, h, int(qp("brightness", "0")))

        elif path == "/api/firmware":
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Firmware download not available on dev server.")

        else:
            self.send_error(404)

    def do_PATCH(self) -> None:
        if not _check_auth(self):
            self._deny_auth()
            return
        global _led_state
        parsed = urlparse(self.path)
        if parsed.path == "/api/led":
            if not _features["led"]:
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            if "state" in body:
                _led_state = bool(body["state"])
            self._send_json({"state": _led_state})
        elif parsed.path == "/api/config/stored":
            self._patch_stored_config()
        else:
            self.send_error(405)

    def _patch_stored_config(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) or b"{}"
        try:
            patch = json.loads(raw)
        except json.JSONDecodeError as e:
            self._send_error_text(400, f"invalid JSON: {e.msg}")
            return
        if not isinstance(patch, dict):
            self._send_error_text(400, "request body must be a JSON object")
            return
        global _stored_config, _stored_is_modified
        if _stored_config is None:
            _stored_config = {**_DEFAULT_CONFIG}
        # RFC 7396-style merge for top-level keys: null clears, arrays replace,
        # objects deep-merge, primitives replace. Faithful enough for the dev server.
        for k, v in patch.items():
            if v is None:
                _stored_config[k] = _DEFAULT_CONFIG.get(k)
            elif isinstance(v, dict) and isinstance(_stored_config.get(k), dict):
                _stored_config[k] = {**_stored_config[k], **v}
            else:
                _stored_config[k] = v
        # Mirror device: auth.password (cleartext from UI) is hashed and stored
        # as auth.password_sha256 before being persisted.
        auth = _stored_config.get("auth")
        if isinstance(auth, dict) and isinstance(auth.get("password"), str) and auth["password"]:
            auth["password_sha256"] = hashlib.sha256(auth["password"].encode()).hexdigest()
            del auth["password"]
        _stored_is_modified = True
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self) -> None:
        if not _check_auth(self):
            self._deny_auth()
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/config/stored/known_networks":
            self._put_known_network()
        else:
            self.send_error(405)

    def do_DELETE(self) -> None:
        if not _check_auth(self):
            self._deny_auth()
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/config/stored":
            global _stored_config, _stored_is_modified
            _stored_config = None
            _stored_is_modified = True
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif parsed.path == "/api/config/stored/known_networks":
            self._delete_known_network(parse_qs(parsed.query).get("ssid", [""])[0])
        else:
            self.send_error(405)

    def _put_known_network(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) or b"{}"
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError as e:
            self._send_error_text(400, f"invalid JSON: {e.msg}")
            return
        if not isinstance(entry, dict):
            self._send_error_text(400, "request body must be a JSON object")
            return
        ssid = entry.get("ssid")
        if not isinstance(ssid, str) or not ssid:
            self._send_error_text(400, "entry must have a non-empty ssid")
            return
        # Mirror the device's canonical form: missing / null / empty password = open network → null.
        if not entry.get("password"):
            entry["password"] = None
        global _stored_config, _stored_is_modified
        # Mirror the device: PUT creates stored if it was absent / outdated.
        if _stored_config is None:
            _stored_config = {**_DEFAULT_CONFIG}
        networks = list(_stored_config.get("known_networks") or [])
        for i, existing in enumerate(networks):
            if isinstance(existing, dict) and existing.get("ssid") == ssid:
                networks[i] = entry
                break
        else:
            networks.append(entry)
        _stored_config["known_networks"] = networks
        _stored_is_modified = True
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _delete_known_network(self, ssid: str) -> None:
        if not ssid:
            self._send_error_text(400, "missing ssid")
            return
        global _stored_config, _stored_is_modified
        if _stored_config is None:
            _stored_config = {**_DEFAULT_CONFIG}
        networks = list(_stored_config.get("known_networks") or [])
        _stored_config["known_networks"] = [n for n in networks if not (isinstance(n, dict) and n.get("ssid") == ssid)]
        _stored_is_modified = True
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _copy_stored_from(self, source: str) -> None:
        # Mirrors the device: reload stored from one of the baseline sources.
        # "active" is intentionally not supported (can't edit the running snapshot).
        sources = {"embedded": get_active_config(), "default": _DEFAULT_CONFIG}
        src = sources.get(source)
        if src is None:
            self._send_error_text(400, "source must be 'embedded' or 'default'")
            return
        global _stored_config, _stored_is_modified
        _stored_config = dict(src)
        _stored_is_modified = True
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_error_text(self, status: int, msg: str) -> None:
        body = msg.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if not _check_auth(self):
            self._deny_auth()
            return
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/restart":
            self._send_text("Restarting.")
            import threading

            def _restart() -> None:
                time.sleep(0.5)
                os.execv(sys.executable, [sys.executable] + sys.argv)

            threading.Thread(target=_restart, daemon=True).start()
        elif path == "/api/poweroff":
            self._send_text("Powering off.")
            import threading

            threading.Thread(target=self.server.shutdown, daemon=True).start()
        elif path == "/api/config/stored/copy":
            self._copy_stored_from(qs.get("from", [""])[0])
        elif path == "/api/wifi/reconnect":
            self._send_text("Reconnecting to WiFi.")
        elif path == "/api/led/blink":
            if not _features["led"]:
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)  # consume body, blink not simulated
            self._send_text("OK")
        elif path == "/api/firmware":
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)  # consume body, OTA not simulated
            self._send_text("OTA update not supported on dev server.")
        else:
            self.send_error(405)

    # ---- helpers ----

    def _send_json(self, data: Any) -> None:
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str) -> None:
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_mjpeg(self, width: int, height: int, scene: int = 0) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace;boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                jpeg = make_jpeg(width, height, scene)
                self.wfile.write(
                    b"\r\n--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg
                )
                self.wfile.flush()
                time.sleep(1 / 30)  # ~30 FPS
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Each connection runs in its own thread (MJPEG + page loads concurrently)."""

    daemon_threads = True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KikkerX development HTTP server")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
    parser.add_argument(
        "--board",
        choices=list(_BOARD_FEATURES.keys()),
        help="Simulate a specific board's feature set (default: all features enabled)",
    )
    args = parser.parse_args()

    if args.board:
        _features.update(_BOARD_FEATURES[args.board])
        print(f"Board: {args.board} — features: {_features}")
    else:
        print(f"Board: (default) — features: {_features}")

    httpd = ThreadedHTTPServer(("0.0.0.0", args.port), KikkerXHandler)
    print(f"KikkerX dev server → http://localhost:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
