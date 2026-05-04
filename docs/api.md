# API

All endpoints are plain HTTP. If authentication is enabled, pass credentials with every request using HTTP Basic auth:

```sh
curl -u admin "http://kikker-x.local/api/status"
# curl will prompt for the password
```

Or inline (less safe — visible in shell history):

```sh
curl -u admin:password "http://kikker-x.local/api/status"
```

The examples below omit `-u` for brevity; add it if auth is enabled. Use `--fail-with-body` to get a non-zero exit code
and a visible error on auth failures or other HTTP errors.

---

## Status

```sh
curl "http://kikker-x.local/api/status"
# → { "battery": { "voltage": 3850, "level": 75 },
#     "id": "c0ffeefacade",
#     "wifi": { "mode": "station", "ssid": "HomeNet", "ip": "192.168.1.50", "rssi": -52 },
#     "version": "1.2.0",
#     "config_policy": "LOAD_OR_USE_EMBEDDED",
#     "allow_ota": true,
#     "camera": "kikker-x",
#     "features": { "board": "M5Stack Timer Camera X", "led": true, "battery": true } }
```

`battery` is omitted for boards without battery monitoring. `features.led` and `features.battery` indicate which
optional hardware is present. `camera` is always `"kikker-x"` and can be used to identify the firmware type.

In AP mode `wifi.mode` is `"ap"`, `ssid` and `ip` reflect the soft AP, and `rssi` is absent.

### Short modes

Pass `?mode=` to get a lighter response:

```sh
curl "http://kikker-x.local/api/status?mode=short"
# → { "wifi": { "ssid": "HomeNet", "rssi": -52 }, "battery": { "voltage": 3850, "level": 75 } }
```

```sh
curl "http://kikker-x.local/api/status?mode=short_text"
# → WiFi: HomeNet (-52dB), Battery: 3850mV (75%)
```

`short` returns a JSON subset. `short_text` returns a plain-text one-liner — useful for logging alongside recordings
(see `--status-url` in [video-saver.md](video-saver.md)). Both omit `rssi` in AP mode and omit `battery` on boards
without battery monitoring.

---

## Configuration

```sh
curl "http://kikker-x.local/api/config"
# → { "policy": "LOAD_OR_USE_EMBEDDED",
#     "active_source": "stored",
#     "schema_version": 2,
#     "can_edit_stored": true,
#     "active":   { "is_active": true,  "schema_version": 2, "config": { "mdns": "kikker-x", ... } },
#     "stored":   { "is_active": true,  "is_modified": false, "schema_version": 2,
#                   "config": { "mdns": "kikker-x", ... } },
#     "embedded": { "is_active": false, "schema_version": 2, "config": { "mdns": "kikker-x", ... } },
#     "default":  { "is_active": false, "schema_version": 2, "config": { "mdns": null,        ... } } }
```

Inspect what the device is running on. The response lists the config sources, which ones are active, and which one is
the primary read source. For more information about the config and config policies, see
[configs/README.md](../configs/README.md).

- `policy` — compile-time `CONFIG_POLICY` name (e.g. `USE_EMBEDDED`, `LOAD_OR_USE_DEFAULT`).
- `active_source` — `"stored"`, `"embedded"`, or `"default"`: the single source the firmware reads at runtime.
- `schema_version` (top level) — the firmware's current `CONFIG_SCHEMA_VERSION`.
- `can_edit_stored` — `true` if the current policy reads NVS at runtime (`LOAD_OR_*`). The stored-config edit endpoints
  below return `405 Method Not Allowed` when this is `false`.
- `active` — the config currently running in RAM (snapshot taken at boot); always present. `active.is_active` is always
  `true`. Diverges from `stored` after a successful `PATCH`/`PUT`/`DELETE` — see `stored.is_modified` below.
- `stored` — NVS-stored config, or `null` when NVS has no entry and has not been edited this boot. `stored.config` is
  `null` if `stored.schema_version` doesn't match the top-level `schema_version` (preserved for inspection but ignored
  at runtime). `stored.is_modified` is `true` after a successful edit — NVS no longer matches `active`; restart the
  device to apply.
- `embedded` — firmware-embedded config, or `null` when the policy doesn't use it (`LOAD_OR_USE_DEFAULT`,
  `LOAD_OR_FAIL`). If embedded is present but fails to parse, the device shuts down rather than serving this response.
- `default` — always present; the firmware defaults (as if `_config.json` were `{}`). Useful for showing which settings
  differ from defaults.
- Each source entry carries `is_active: bool` — true when the policy keeps that source in sync with the runtime config
  this boot (either read, or written by a `STORE_*` policy). Typically only one source is active, but in
  `STORE_EMBEDDED` (always) and `LOAD_OR_STORE_EMBEDDED` (on NVS miss) both `embedded` (read) and `stored` (written) are
  flagged active — the policy mirrors embedded into NVS every boot. A stored entry with `is_modified: true` has
  `is_active: false` regardless of policy.

Passwords are redacted to `"***"` (or `"RANDOM"` for an AP fallback configured to generate one at boot). Password hashes
are shown as the first 6 hex chars followed by `***`.

### Editing the stored config

The endpoints below write directly to NVS and only take effect on the **next boot** — the running config is a snapshot
taken at startup. They require `can_edit_stored: true` (i.e. policy is `LOAD_OR_*`); on other policies they respond
`405 Method Not Allowed`. Success is `204 No Content`; validation failures are `400 Bad Request` with the reason in the
body. The web UI at `/config` exposes these.

No validation of "safety" is performed — any change that parses is accepted, including ones that lock you out. The one
guarantee is that the stored blob is always canonical: unknown keys are stripped, wrong-type values are coerced to
defaults. The canonical shape is what lands in NVS.

```sh
curl -X PATCH "http://kikker-x.local/api/config/stored" \
  -H "Content-Type: application/json" \
  -d '{"mdns": "kitchen-cam", "known_networks": null}'
# → 204 No Content
```

RFC 7396 JSON Merge Patch on the stored config. Objects are deep-merged; arrays replace wholesale (no append); a `null`
value clears a key (reverting to the firmware default on next boot). Creates a fresh stored entry when NVS is empty or
has a schema mismatch.

For `auth`, the patch must use `password` (cleartext) — it is hashed server-side and persisted as `password_sha256`. The
latter is what `GET /api/config` returns (redacted to `"abc123***"`); a `password` field is never read back or stored on
the device.

```sh
curl -X PUT "http://kikker-x.local/api/config/stored/known_networks" \
  -H "Content-Type: application/json" \
  -d '{"ssid": "HomeNet", "password": "..."}'
# → 204 No Content
```

Adds or replaces a single `known_networks` entry (matched by SSID). Entry fields follow the schema in
[`config.json.template`](../configs/config.json.template): `ssid`, `password`, and optional `static_ip`, `subnet_mask`,
`gateway`, `dns`. Creates the stored entry if absent.

```sh
curl -X DELETE "http://kikker-x.local/api/config/stored/known_networks?ssid=HomeNet"
# → 204 No Content
```

Removes the `known_networks` entry whose SSID matches the `ssid` query parameter. URL-encode the value if it contains
special characters. Idempotent — returns 204 even if no entry matched.

```sh
curl -X DELETE "http://kikker-x.local/api/config/stored"
# → 204 No Content
```

Wipes the stored config. Semantically a reset — on next boot the device falls back per policy (embedded config, or
firmware defaults for `LOAD_OR_USE_DEFAULT`). Under `LOAD_OR_FAIL` the device will refuse to start, and since the write
endpoint only runs while firmware is up, recovery requires re-flashing over USB.

```sh
curl -X POST "http://kikker-x.local/api/config/stored/copy?from=embedded"
# → 204 No Content
```

Replaces the stored config with a baseline source. `from=embedded` copies the firmware-embedded JSON verbatim (real
passwords preserved); `from=default` copies the firmware defaults (equivalent to `{}`, used for the `/config` page's
"Create" / "Reset to Default" actions). `400 Bad Request` if `from` is missing or unknown, or if the requested source
isn't available on the current policy (e.g. `from=embedded` on `LOAD_OR_USE_DEFAULT`).

---

## Camera

```sh
curl "http://kikker-x.local/api/cam/stream.mjpeg?res=VGA&quality=12&brightness=0" --output stream.mjpeg
```

Returns a `multipart/x-mixed-replace` MJPEG stream. Supported resolutions: `QQVGA` (160×120), `QVGA` (320×240), `CIF`
(400×296), `VGA` (640×480), `SVGA` (800×600), `XGA` (1024×768), `SXGA` (1280×1024), `UXGA` (1600×1200).

```sh
curl "http://kikker-x.local/api/cam/capture.jpg?res=UXGA&quality=4" --output photo.jpg
```

Returns a single JPEG still. Defaults to UXGA and quality 4 (high). Accepts the same sensor parameters as the stream.
Add `raw=1` to apply only the parameters explicitly present in the URL (useful for scripted capture).

When the camera is already serving another capture, both endpoints respond `503 Service Unavailable` with
`Retry-After: 1` — the client should wait the indicated number of seconds and retry.

```sh
curl "http://kikker-x.local/api/streamfps"
# → { "fps": 9.4, "active": true }
```

---

## LED

```sh
curl "http://kikker-x.local/api/led"
# → { "state": false }

curl -X PATCH "http://kikker-x.local/api/led" -H "Content-Type: application/json" -d '{"state": true}'
# → { "state": true }

curl -X POST "http://kikker-x.local/api/led/blink" -H "Content-Type: application/json" -d '{"pattern": "200,200,200,200,200"}'
```

The blink pattern is a comma-separated list of millisecond durations (on, off, on, off, …). Total must not exceed 5000
ms. The LED returns to its previous state afterwards.

---

## Power

```sh
curl -X POST "http://kikker-x.local/api/poweroff?duration=0"        # permanent power-off
curl -X POST "http://kikker-x.local/api/poweroff?duration=3600"     # sleep for 1 hour
curl -X POST "http://kikker-x.local/api/restart"                    # reboot the device
```

`duration=0` powers off permanently. Any other value (in seconds) puts the device into deep sleep and it wakes
automatically after `N` seconds. The web UI enforces a maximum of 15,300 seconds (255 minutes).

`/api/restart` performs a clean software reboot (`ESP.restart()`). The device responds with `200 OK` before rebooting,
so the response confirms the request was received.

---

## Firmware update (OTA)

```sh
curl -X POST "http://kikker-x.local/api/firmware" \
  --data-binary @.pio/build/kikker-x-timercam-default/firmware.bin \
  -H "Content-Type: application/octet-stream"
# → OTA update complete. Rebooting.
```

Uploads a firmware binary and reboots into it. The body must be a raw `.bin` file as produced by PlatformIO
(`.pio/build/<env>/firmware.bin`). The binary is streamed directly into the inactive OTA flash partition, verified, and
the device reboots.

As the upload streams in, the firmware extracts the new image's version from an embedded marker and rejects the update
if it would be a downgrade. After rebooting, the new firmware runs a self-test (camera init + capture). If it passes,
the firmware is confirmed. If it fails (or the device crashes before confirming), the bootloader rolls back to the
previous firmware on the next boot.

The web UI at `/ota` wraps the same endpoint and adds: file / URL upload modes, drag-and-drop, pre-upload parsing of the
new firmware's version (displayed in the confirmation dialog), and a progress indicator.

Returns `404` if `"allow_ota": false` is set in the config.

---

## WiFi

```sh
curl -X POST "http://kikker-x.local/api/wifi/reconnect"
```

Responds immediately, then waits 3 seconds and reconnects — selecting the strongest visible known network. Useful for
roaming to a different access point. Also works in AP mode to force an immediate attempt to join a known network.

---

## Logs

```sh
curl "http://kikker-x.local/api/logs"   # plain-text in-memory log buffer
```

---

## Hub

```sh
curl "http://kikker-x.local/api/hub/status"
# → { "isStandalone": false, "store": { "read": true } }

curl "http://hub-server:8765/api/hub/status"
# → { "isStandalone": true, "version": "1.5.0", "store": { "read": true, "write": true } }
```

Returns hub metadata. `isStandalone` is `false` on the device and `true` on the standalone server. `version` is the
standalone server's version (absent on the device; the device reports its version via `/api/status`). `store.read`
indicates the store can be read (`GET /api/hub/store`); `store.write` indicates it can also be written
(`PUT /api/hub/store`). Both default to `false` when absent.

```sh
curl "http://kikker-x.local/api/hub/store"
# → { "version": 1, "cameras": [{ "url": "SELF", "type": "kikker-x" }], "auths": [] }
```

Returns the initial store for the hub. On the device this always returns the device itself as the sole camera (`url` is
`"SELF"` — a self-reference marker replaced by the hub with `window.location.origin` so it works regardless of whether
the device was accessed via IP or mDNS). The hub merges this into its local state on load so the host camera is always
present.

```sh
curl -X PUT "http://kikker-x.local/api/hub/store" -H "Content-Type: application/json" -d @cameras.json
# → { "ok": true }
```

Saves the full store back to the server. Only supported by `cameras_hub.py` when `--auth-write-user` is configured (i.e.
`store.write` is `true`); the device responds `404`.

---

## CORS

All API responses include `Access-Control-Allow-Origin` and `Vary: Origin` headers when the request carries an `Origin`
header. This allows the Cameras Hub to call any endpoint directly from a browser via `fetch()`.

`OPTIONS` preflight requests are answered with `204 No Content` and the appropriate CORS headers before the auth check,
so cross-origin requests with an `Authorization` header are permitted.
