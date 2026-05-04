# Configuration

At build time, `build_helpers/prepare_config.py` reads and shallow-merges one or more JSON files into
`src/_config.json`, which is then embedded in the firmware via INCBIN.

## Config schema

See `config.json.template` in this directory for all fields and their documentation.

## Config fields and defaults

All fields are optional. When omitted, the firmware uses the defaults below. These defaults apply both to omitted fields
in an embedded config and to the `LOAD_OR_USE_DEFAULT` policy when no config is stored on the device.

| Field                   | Description                                                                      | Default                                    |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| `mdns`                  | mDNS hostname — device is reachable at `<value>.local`                           | `null` (disabled)                          |
| `known_networks`        | WiFi networks to connect to; strongest visible one is chosen                     | `[]` (none — goes straight to AP fallback) |
| `fallback_access_point` | AP to start when no known network is reachable (or none is configured)           | SSID `"KikkerX"`, random 12-char password  |
| `allow_cors`            | Send `Access-Control-Allow-Origin` headers (needed for Cameras Hub cross-origin) | `true`                                     |
| `auth`                  | HTTP Basic Auth — username + SHA-256 hashed password                             | `null` (disabled — all requests allowed)   |
| `allow_ota`             | Allow firmware updates via `POST /api/firmware` and the web UI                   | `true`                                     |

The random AP password is regenerated at each boot and printed to the serial console. To explicitly disable the AP
fallback, set `"fallback_access_point": false`.

See `config.json.template` for detailed per-field documentation and examples.

## Config policy

The config can come from two sources:

- **Embedded** — baked into the firmware binary at build time from JSON files listed in `custom_config_files`. The files
  are shallow-merged in order (later files overwrite top-level keys).
- **NVS** (Non-Volatile Storage) — the ESP32's persistent key-value store that survives reboots and firmware updates.
  When the firmware writes a config to NVS, it also stores a version tag. On read, a version mismatch (e.g. after a
  breaking schema change) causes the stored config to be treated as unavailable.

The `custom_config_policy` option (in `platformio.ini`) controls which source the firmware uses at runtime and whether
it persists the config to NVS:

| Policy                   | Embedded config | NVS read | NVS write     | Fallback              |
| ------------------------ | --------------- | -------- | ------------- | --------------------- |
| `USE_EMBEDDED`           | yes             | no       | no            | —                     |
| `STORE_EMBEDDED`         | yes             | no       | yes           | —                     |
| `LOAD_OR_USE_EMBEDDED`   | yes             | yes      | no            | use embedded          |
| `LOAD_OR_STORE_EMBEDDED` | yes             | yes      | yes (on miss) | use embedded + store  |
| `LOAD_OR_USE_DEFAULT`    | no              | yes      | no            | use firmware defaults |
| `LOAD_OR_FAIL`           | no              | yes      | no            | log + shut down       |

If omitted, the policy defaults to `USE_EMBEDDED`.

Policies that don't embed config (`LOAD_OR_USE_DEFAULT`, `LOAD_OR_FAIL`) produce a binary with no secrets, which enables
`GET /api/firmware` — other cameras can download and install the firmware directly. For policies that embed config
(containing WiFi passwords, auth hashes, etc.), the endpoint returns 403.

## Typical workflow

The default build targets in `platformio.ini` use `LOAD_OR_USE_DEFAULT` — no config is embedded. A fresh camera boots
into AP mode with a random password (firmware defaults). Once you flash a per-camera config via `STORE_EMBEDDED`, the
config is persisted in NVS and survives future firmware updates.

1. **Set up each camera** — create a per-camera environment with `STORE_EMBEDDED` to embed and persist the config (see
   "Adding custom configurations" below). For example:

   ```ini
   ; in configs/platformio.ini (gitignored)
   [env:kikker-x-timercam-living-room]
   extends = kikker-x-timercam
   custom_config_files =
       configs/custom/home_config.json
       configs/custom/living_room_config.json
   custom_config_policy = STORE_EMBEDDED
   ```

   Flash via USB: `pio run -e kikker-x-timercam-living-room -t upload`

   The config (WiFi credentials, auth, mDNS name, etc.) is now stored in NVS on the device.

2. **Update all cameras** — build the default target and push to all cameras of the same board type:

   ```
   pio run -e kikker-x-timercam-default
   ```

   Push via OTA (file upload or URL on the `/ota` page). Since the binary uses `LOAD_OR_USE_DEFAULT`, each camera keeps
   its own config from NVS. Cameras that were never configured boot into AP mode.

3. **Change a camera's config** — re-flash with `STORE_EMBEDDED` to overwrite the NVS config, or for `LOAD_OR_*`
   policies edit it live from the device's `/config` page (no reflash needed; takes effect on next reboot).

## Adding custom configurations

1. Create JSON config files under `configs/custom/` (gitignored).

2. Copy `configs/platformio.ini.template` to `configs/platformio.ini` (also gitignored) and add environments that layer
   your files on top of the defaults. Extend the appropriate board base (`kikker-x-timercam` or `kikker-x-wrovercam`).
   For example:

   ```ini
   [env:kikker-x-timercam-living-room]
   extends = kikker-x-timercam
   custom_config_files =
       configs/custom/home_config.json
       configs/custom/living_room_config.json
   custom_config_policy = STORE_EMBEDDED

   [env:kikker-x-wrovercam-bedroom]
   extends = kikker-x-wrovercam
   custom_config_files =
       configs/custom/home_config.json
       configs/custom/bedroom_config.json
   custom_config_policy = STORE_EMBEDDED
   ```

   In this example:
   - `configs/custom/home_config.json` defines the WiFi networks and login credentials,
   - `configs/custom/living_room_config.json` and `configs/custom/bedroom_config.json` define the camera-specific
     settings, like mDNS (camera name).

3. Build or upload the desired environment: `pio run -e kikker-x-timercam-living-room -t upload`.
