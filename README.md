# KikkerX

<img src="logo.svg" alt="KikkerX logo" width="96">

Wi-Fi camera server firmware for ESP32-based cameras. Streams live MJPEG video, serves full-resolution still photos, and
provides a self-contained web interface — all over plain HTTP with no app or cloud required.

---

## Hardware

Supported boards:

- **[M5Stack Timer Camera X](https://docs.m5stack.com/en/unit/timercam_x)** — OV3660 sensor (up to 1600×1200), built-in
  LiPo charger, BM8563 RTC for timed sleep, and a blue status LED.
- **[ESP-WROVER-DEV](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/hw-reference/esp32/get-started-wrover-kit.html)**
  (and compatible ESP32-WROVER boards) — OV3660 sensor, 4 MB PSRAM, user-controllable blue IO2 LED. No battery
  monitoring; uses the ESP32's built-in timer for timed wake-up.

---

## Features

- **Live MJPEG stream** at any supported resolution (QQVGA → UXGA), served as a standard `multipart/x-mixed-replace`
  response — viewable in any browser or with `ffplay`, `mpv`, etc.
- **Still capture** at up to 1600×1200 (UXGA), with automatic exposure settling.
- **Full OV3660 settings panel** (brightness, contrast, saturation, sharpness, white balance, exposure, gain, lens
  correction, …) shared across the stream and photo pages.
- **Simultaneous stream + capture**: a photo taken while streaming pauses the stream at a frame boundary, captures with
  its own settings, then resumes — no dropped stream connection.
- **Blue LED control**: toggle on/off, or send a one-off arbitrary blink pattern.
- **Timed sleep / power-off**: sleep for a set time, or permanently.
- **WiFi roaming**: connect to the strongest known network, with automatic reconnect on drop.
- **Fallback to access point**: if no known network is reachable, starts a soft access point so the device remains
  reachable; switches back to station mode automatically when a known network reappears.
- **mDNS**: reachable at `http://kikker-x.local/` or a custom hostname.
- **Basic auth** (optional): username + SHA-256-hashed password in the config file.
- **Over-the-air updates**: safely upload a new firmware image through the web UI or `/api/firmware`.
- **Mobile-friendly UI**: responsive layout that works well on phones and tablets.
- **Cameras Hub**: multi-camera dashboard showing live thumbnails and links for any number of KikkerX or other cameras.
  Runs embedded on every device at `/hub`, or standalone via `cameras_hub.py` on any machine.

<table>
  <tr>
    <td valign="top">
      <a href="docs/screenshots/main.png"><img src="docs/screenshots/main.png" alt="Home page" width="240"></a><br>
      <a href="docs/screenshots/video.png"><img src="docs/screenshots/video.png" alt="Video stream" width="240"></a><br>
      <a href="docs/screenshots/photo.png"><img src="docs/screenshots/photo.png" alt="Photo capture" width="240"></a><br>
      <a href="docs/screenshots/mobile.png"><img src="docs/screenshots/mobile.png" alt="Mobile view" width="240"></a>
    </td>
    <td valign="top">
      <a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" alt="Settings panel" width="240"></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <a href="docs/screenshots/hub.png"><img src="docs/screenshots/hub.png" alt="Cameras Hub" width="500"></a>
    </td>
  </tr>
</table>

---

## AI usage and engineering standards

This project is developed with the assistance of AI tools, including Claude Code, Gemini and GitHub Copilot. The main
engineer behind the project is me — a human engineer with 20+ years of professional IT experience. I design the
architecture, and yes, I read and approve all the code, and write some of it. This project is by no means "AI slop" —
the AI was used as a power tool, not as the brain.

And emdashes do look nicer, I copied and pasted them in this paragraph. And some commits are huge because the project
was developed and in flux for a long time, and then I just squashed everything to get a cleaner history.

---

## Quick start

To flash a pre-built firmware without installing any tooling, download `bootloader.bin`, `partitions.bin`, and
`firmware.bin` from the [latest release](../../releases/latest) and flash them with
[esptool](https://github.com/espressif/esptool). Install it with `pip install esptool`, then:

**Linux / macOS** — replace `/dev/ttyUSB0` with your port:

```sh
esptool.py --chip esp32 --port /dev/ttyUSB0 --baud 115200 write-flash \
    0x1000  bootloader.bin \
    0x8000  partitions.bin \
    0x10000 firmware.bin
```

**Windows** — replace `COM3` with your port (check Device Manager). Use `esptool.exe` if you have the standalone
executable, or `esptool.py` if installed via pip:

```powershell
esptool.exe --chip esp32 --port COM3 --baud 115200 write-flash `
    0x1000  bootloader.bin `
    0x8000  partitions.bin `
    0x10000 firmware.bin
```

The default firmware starts an access point named **KikkerX** with a randomly generated password. Connect a serial
monitor (115200 baud) to read the password from the boot log, then connect to the AP and open `http://192.168.4.1/`.

To use your own WiFi network or change any settings, follow the [Getting started guide](docs/getting-started.md) to
build and flash a custom config.

---

## Getting started

Install PlatformIO, write a config file with your WiFi credentials, and flash. [uv](https://docs.astral.sh/uv/) is
needed only for development or the video recorder.

→ [Getting started guide](docs/getting-started.md)

---

## Web interface

Open `http://kikker-x.local/` (or the configured mDNS hostname, shown also in the serial log at startup).

| Page  | URL      | Description                                      |
| ----- | -------- | ------------------------------------------------ |
| Home  | `/`      | Status, battery, WiFi, LED, power management     |
| Video | `/video` | Live MJPEG stream + settings panel               |
| Photo | `/photo` | Still capture + settings panel                   |
| Logs  | `/logs`  | Scrollable in-memory log buffer                  |
| OTA   | `/ota`   | Upload a new firmware image (with version check) |

The settings panel on the Video and Photo pages exposes all OV3660 sensor parameters.

The advanced panel shows also the URL of the raw stream or capture endpoint with the currently selected parameters —
useful for copy-pasting into scripts. See the API section below for details.

---

## API

Plain HTTP endpoints for status, camera stream/capture, LED, power, WiFi, and logs. All support HTTP Basic auth when
enabled.

→ [API reference](docs/api.md)

---

## Cameras Hub

Multi-camera dashboard — view thumbnails and links for any number of KikkerX or other cameras. Runs embedded on each
device, or standalone via `cameras_hub.py` (no hardware needed).

→ [Cameras Hub documentation](docs/cameras-hub.md)

---

## Recording to video

`video_saver.py` records the MJPEG stream or a timelapse to H.264 MP4 files using `ffmpeg`. Supports rolling files,
battery-saving deep sleep between timelapse frames, and status logging.

→ [video_saver.py documentation](docs/video-saver.md)

---

## Development server

`fake_server.py` serves the static UI from `static/` and simulates all API endpoints — no hardware needed.

→ [Development guide](docs/development.md)

---

## Repository layout

| Path                                                          | Description                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                                        | The firmware source code                                                                                                    |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`kikker-x.cpp`            | Main firmware (HTTP server, camera, LED, power, OTA)                                                                        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`board.h`                 | Board abstraction interface (camera init, LED, battery, sleep)                                                              |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`boards/`                 | Per-board implementations (`timercam_board.cpp`, `wrover_board.cpp`)                                                        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`_config.json`            | Generated at build time by `prepare_config.py` (merged from configured files)                                               |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`_static_files.h`         | Generated at build time by `embed_static.py` (gzip-compressed from `static/*`)                                              |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`_version.h`              | Generated at build time by `generate_version.py` (from `pyproject.toml`)                                                    |
| `configs/`                                                    | Configuration files                                                                                                         |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`config.json.template`    | Documents all config fields with comments                                                                                   |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`platformio.ini`          | Local PlatformIO overrides — not committed (see template)                                                                   |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`platformio.ini.template` | Template for multi-device configs                                                                                           |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`README.md`               | Config system documentation                                                                                                 |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`custom/`                 | Per-device config files — not committed (gitignored)                                                                        |
| `build_helpers/`                                              | Build scripts                                                                                                               |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`generate_version.py`     | PlatformIO pre-script: reads version from `pyproject.toml` → `src/_version.h`                                               |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`embed_static.py`         | PlatformIO pre-script: gzip-compresses `static/*` → embeds in firmware                                                      |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`prepare_config.py`       | PlatformIO pre-script: merges config files → `src/_config.json`                                                             |
| `static/`                                                     | Web assets (HTML, CSS, JS, SVG) — served from `fake_server.py` / `cameras_hub.py`, embedded gzip-compressed in the firmware |
| `helpers/`                                                    | One-off maintenance scripts                                                                                                 |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`generate_logo_png.py`    | Re-generate `logo.png` from `logo.svg` (run when the SVG logo changes)                                                      |
| [`fake_server.py`](docs/development.md)                       | Development HTTP server (no hardware needed)                                                                                |
| [`video_saver.py`](docs/video-saver.md)                       | MJPEG/timelapse recorder → H.264 MP4                                                                                        |
| [`cameras_hub.py`](docs/cameras-hub.md)                       | Standalone Cameras Hub server (no device needed)                                                                            |
| `format.py`                                                   | Formats C++, JS/HTML/CSS, Python, and Markdown                                                                              |
| `checks.py`                                                   | Lints and type-checks JS/HTML/CSS and Python (`--fix` to auto-fix)                                                          |
| `platformio.ini`                                              | PlatformIO project configuration                                                                                            |
| `LICENSE`                                                     | MIT License                                                                                                                 |
| `docs/`                                                       | Documentation pages                                                                                                         |

---

## Development

Format (clang-format, Biome, ruff, prettier) and check (Biome, ruff, mypy) with `./format.py` and `./checks.py`. Pass
`--fix` to `checks.py` to auto-fix lint and formatting issues.

→ [Development guide](docs/development.md)

---

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 TPReal.
