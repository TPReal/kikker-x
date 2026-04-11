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
#      "id": "c0ffeefacade",
#      "wifi": { "mode": "station", "ssid": "HomeNet", "ip": "192.168.1.50", "rssi": -52 },
#      "version": "1.2.0",
#      "camera": "kikker-x",
#      "features": { "board": "M5Stack Timer Camera X", "led": true, "battery": true } }
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
# → { "isStandalone": true, "store": { "read": true, "write": true } }
```

Returns hub metadata. `isStandalone` is `false` on the device and `true` on the standalone server. `store.read`
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
