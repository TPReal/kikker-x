# Cameras Hub

The Cameras Hub is a multi-camera dashboard that shows thumbnails, links, and status for any number of KikkerX (or
other) cameras. It runs either embedded on every KikkerX device, or as a standalone server on any machine on the
network.

<a href="screenshots/hub.png"><img src="screenshots/hub.png" alt="Cameras Hub" width="600"></a>

---

## Standalone server

`cameras_hub.py` serves just the hub page — no camera hardware needed. Any machine on the local network can run it.

```sh
python cameras_hub.py               # http://localhost:8765/
python cameras_hub.py --port 8080   # custom port
```

### Loading a cameras config

Pass a JSON file to pre-populate the hub with cameras on load:

```sh
python cameras_hub.py --store cameras_store.json
```

The file uses the same JSON format as the hub's **Export** (see [Import / Export](#import--export) below). On startup,
the server merges the file into the browser's local storage. Edits stay local unless the user explicitly saves via
**Save to server** (requires write credentials).

The file is created on first save if it does not yet exist, if `--auth-write-user` is configured.

### Authentication

If the `--store` file is specified, two sets of credentials control access to it. Use `"*"` as the username to allow
that operation without credentials.

| Flag                               | Controls                                   | If not specified |
| ---------------------------------- | ------------------------------------------ | ---------------- |
| `--auth-user` / `…-password`       | Who may **read** the store file.           | Open read access |
| `--auth-write-user` / `…-password` | Who may **read and write** the store file. | No write access  |

Both flags may use different credentials, or the same — if the read and write credentials match, a single login grants
both, and password is configured by `--auth-password`.

Passwords can be supplied as a literal value, read from a file with `@/path/to/file`, read from stdin with `@-`, or
prompted interactively when running in a terminal (omit the password flag entirely).

```sh
# Public read, authenticated write:
python cameras_hub.py --store cameras_store.json \
  --auth-write-user admin --auth-write-password secret

# Protected read and write, same credentials (--auth-write-password omitted — password is shared):
python cameras_hub.py --store cameras_store.json \
  --auth-user admin --auth-password secret \
  --auth-write-user admin

# Protected read and write, separate credentials:
python cameras_hub.py --store cameras_store.json \
  --auth-user viewer --auth-password viewpass \
  --auth-write-user admin --auth-write-password adminpass

# Public read and write (no credentials):
python cameras_hub.py --store cameras_store.json \
  --auth-write-user "*"
```

Credentials are not stored in a persistent session. When the page loads it fetches the store; if credentials are
required a dialog appears. On cancel the page runs from local browser storage only. When saving, credentials are
prompted if not yet provided. Credentials are cached in memory and cleared on page refresh.

**Note:** Password-protecting the hub does not secure access to the cameras.

---

## Embedded hub

The hub is also embedded in the KikkerX firmware and served from the device under the `/hub` path. It does not allow
saving the configuration permanently, but more cameras can be added and stored in browser local storage.

If auth is configured on the device, the hub pre-populates an auth entry with the username so that the password prompt
is pre-filled when credentials are needed (e.g. after importing the exported config on another hub).

---

## Camera types

### KikkerX

Add a KikkerX camera by entering its base URL (e.g. `http://kikker-x-garden.local`). The hub links to its Home, Photo,
and Video pages and fetches thumbnails from `/api/cam/capture.jpg`.

**Capture params** — optional query parameters appended to the thumbnail and capture URL, e.g. `aec2=1`. Useful to avoid
requesting a full-resolution image for every refresh.

### Other

Add any camera that exposes a direct JPEG or MJPEG snapshot URL. The hub shows the thumbnail and a single "Open" link.

---

## Cameras authentication

The hub supports HTTP Basic auth for cameras that require credentials.

**Saved auths** are stored in the browser's local storage (or in the server file when using **Save to server**). An auth
entry has an optional name, a username, and an optional password. If password is missing, it is prompted on the hub page
when needed. Multiple cameras can share the same saved auth. Manage saved auths from the **Auths** button in the
toolbar.

**Session credentials** — if a camera returns 401 or 403, an inline prompt appears on its card. Enter credentials and
click **Use** to apply them for the current page session only, or **Save** to persist them in the local storage.

---

## Import / Export

Use **Export** and **Import** to transfer your camera list between browsers or to back it up.

The exported JSON format (passwords are encoded as `\uXXXX` Unicode escapes):

```json
{
  "version": 1,
  "cameras": [
    {
      "url": "http://garden.local",
      "type": "kikker-x",
      "name": "Garden",
      "authId": null
    }
  ],
  "auths": [
    {
      "id": "...",
      "name": "Home network",
      "username": "admin",
      "password": "\u0073\u0065\u0063\u0072\u0065\u0074"
    }
  ]
}
```

When importing, tick **Replace all** to overwrite the current list; unticked (default) merges — cameras with the same
URL and type are skipped.

---

## CORS

Browsers block cross-origin `fetch()` requests unless the server sends `Access-Control-Allow-Origin` headers. KikkerX
firmware sends these headers by default; many other cameras do not.

For cameras without CORS headers, the hub automatically falls back to loading the thumbnail via an `<img>` element,
which browsers allow for display-only use. The following hub features are unavailable for cameras without CORS:

- **Auth headers** — `<img>` cannot carry an `Authorization` header, so camera auth does not work through the hub.
- **Status info** — the battery/WiFi tooltip is fetched via `fetch()`; it will not appear for KikkerX cameras.
- **Error details** — when a thumbnail request fails, the browser does not expose the response body across origins, so
  only the HTTP status code is shown (e.g. `HTTP 503` without the message text).

KikkerX CORS can be disabled in the config with `"allow_cors": false`. This may be desirable for stricter network
environments, at the cost of the hub features listed above.
