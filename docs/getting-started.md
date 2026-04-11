# Getting started

## 1. Install tooling

### PlatformIO

Install [PlatformIO](https://platformio.org/install) — either the CLI or the VS Code extension. Required for building
and flashing the firmware.

### uv (optional)

[uv](https://docs.astral.sh/uv/) is needed if you want to:

- Use the **[video recorder](video-saver.md)** (`./video_saver.py`)
- Do **[development](development.md)** — run the fake server (`./fake_server.py`) or format/lint checks (`./format.py`,
  `./checks.py`)

If you only want to build and flash the firmware, you can skip this. Python 3.11 or higher is required (also by the
PlatformIO build scripts).

To install **uv**:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then install Python dependencies:

```sh
uv sync
```

**WSL note:** uv may warn about falling back to full copy instead of hardlinks. This is expected when the uv cache and
the project are on different filesystems. To suppress it, set
[`UV_LINK_MODE=copy`](https://docs.astral.sh/uv/reference/environment/) in your shell profile:

```sh
echo 'export UV_LINK_MODE=copy' >> ~/.bashrc   # or ~/.zshrc
```

---

## 2. Configure

All configuration lives in a single JSON file embedded into the firmware as assets at build time. The template at
`configs/config.json.template` documents all fields.

For a single device, the quickest path is to add a config file under `configs/custom/` (gitignored) and point the build
at it. See `configs/README.md` for the full workflow, including multi-device setups.

A minimal config looks like:

```json
{
  "mdns": "kikker-x",
  "known_networks": [
    { "ssid": "HomeNet", "password": "hunter2" },
    { "ssid": "PhoneHotspot", "password": "hunter3" }
  ],
  "fallback_access_point": {
    "ssid": "KikkerX",
    "password": "password or RANDOM"
  },
  "auth": null
}
```

The device connects to the strongest visible network from `known_networks`. Multiple entries are useful for roaming e.g.
between home and a phone hotspot.

If no known network is reachable after three scan attempts, the device starts a soft access point using the
`fallback_access_point` credentials. Connect to it and browse to `http://192.168.4.1/` to reach the web interface. The
device scans every 5 minutes while in AP mode and switches back to station mode automatically once a known network
becomes visible again.

Setting `"password": "RANDOM"` generates a random 12-character password at boot and prints it to the serial log.

Set `"fallback_access_point": null` to disable the fallback — the device will then retry indefinitely instead of
starting an AP.

If `known_networks` is empty, the device goes straight to AP mode without scanning.

Optional static IP per network entry:

```json
{
  "ssid": "HomeNet",
  "password": "hunter2",
  "static_ip": "192.168.1.50",
  "subnet_mask": "255.255.255.0",
  "gateway": "192.168.1.1",
  "dns": "8.8.8.8"
}
```

**Authentication** — set a username and a SHA-256 hash of the password. You can calculate the hash with
`IFS= read -rsp 'Password: ' pass && echo && printf '%s' "$pass" | sha256sum | cut -d' ' -f1; unset pass`. Paste the
resulting hash into `pass_sha256`. To disable auth entirely, set `"auth": null`.

**mDNS hostname** — set `"mdns"` to the full hostname you want:

```json
{ "mdns": "kikker-x-garden" }
```

This device will then be reachable at `http://kikker-x-garden.local/`.

---

## 3. Build and flash

Two built-in environments cover the supported boards:

```sh
pio run -e kikker-x-timercam-default --target upload   # M5Stack Timer Camera X
pio run -e kikker-x-wrovercam-default --target upload  # ESP-WROVER-DEV
```

For named per-device environments, define them in `configs/platformio.ini` (see `configs/platformio.ini.template` and
`configs/README.md`) and then:

```sh
pio run -e kikker-x-garden --target upload
```

Watch the serial output for the assigned IP address:

```sh
pio device monitor
```

Open the printed URL (or `http://kikker-x.local/`) in a browser. You should see the home page:

<a href="screenshots/main.png"><img src="screenshots/main.png" alt="Home page" width="280"></a>

The interface is mobile-friendly and works well on phones and tablets:

<a href="screenshots/mobile.png"><img src="screenshots/mobile.png" alt="Mobile view" width="200"></a>
