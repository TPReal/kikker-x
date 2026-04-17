# Ideas

Notes on features that aren't implemented yet. Not referenced from anywhere.

---

## Firmware rollback

ESP32 has two OTA app partitions. After `esp_ota_set_boot_partition` + reboot, the previous firmware is still present in
the inactive slot and can be rolled back to — but only while it remains a _confirmed_ image. If the last OTA slot holds
a failed/reverted firmware, rollback is unavailable.

Proposed endpoints:

- `GET /api/firmware/rollback` — returns the rollback status:

  ```json
  { "available": true, "from_version": "1.4.0", "to_version": "1.3.0" }
  ```

  or `{ "available": false, "reason": "..." }`. Reasons: only one slot, inactive slot not valid, inactive slot is the
  failed-update carcass from the last OTA attempt, etc. The version of the inactive slot would need to be read from its
  image header (or from a version marker the firmware writes into NVS when it confirms itself).

- `POST /api/firmware/rollback` — marks the inactive slot as boot target and reboots. Responds with `200` before
  rebooting if the call succeeds; otherwise `409 Conflict` with a reason.

UI: a "Roll back to v1.3.0" button on `/ota`, shown only when the GET endpoint reports `available: true`. Hidden (or
disabled with a tooltip) otherwise.

The main unreliability is that after a successful OTA + self-test, the previous slot's partition is no longer guaranteed
to contain a bootable image — ESP-IDF may still hold it briefly, but an update that writes to that slot (the next OTA
upload) erases it. So the button is only useful in a narrow window after an upgrade.

---

## Writing the stored config over HTTP

`GET /api/config` (see `/config` page) already exposes the stored (NVS) and embedded configs read-only. Natural next
step: let the user edit the stored config without reflashing.

Shape:

- `PATCH /api/config` — body is a JSON object with only the fields to change; server merges into the current stored
  config, re-validates, commits to NVS, then reboots. Redacted placeholders (`"***"`, `"0a1b2c***"`) are treated as
  "leave unchanged".
- `DELETE /api/config` — wipe the stored config from NVS and reboot. Useful for resetting a camera back to
  embedded/default behavior without flashing.

Only available when `config_policy` actually uses NVS (`STORE_EMBEDDED`, `LOAD_OR_*`). For `USE_EMBEDDED`, NVS is never
read, so writing to it would silently do nothing.

Complications:

- **Brick risk.** The obvious one: edit WiFi credentials wrong, device reboots into AP fallback (or hangs forever if
  `fallback_access_point: false`). Partially mitigated by keeping the embedded fallback intact — the stored config can
  be wiped via serial, or reset by reflashing.
- **Validation.** Need schema checks (known keys, required types) before commit. Ideally a "try WiFi before persisting"
  step for network changes, but that's a substantial extra mechanism (stage in a tmp NVS slot, try it, promote or
  revert).
- **Auth reconfiguration.** If the user changes `auth.password_sha256` and gets it wrong, they're locked out. Same
  serial/reflash escape hatch applies.
- **Schema version.** On `CONFIG_SCHEMA_VERSION` bump, the stored config is already discarded at load time. Patching
  should preserve whatever forward-compat behaviour we decide on.

The cheaper narrow alternative: `POST /api/wifi` that takes just an SSID + password and writes only `known_networks` —
covers the most-common remote change without the general config-editing attack surface.

---

## Flashing from another KikkerX camera

On the `/ota` page, offer a third mode alongside "Upload file" and "Fetch from URL": pull the firmware directly from
another KikkerX camera on the network. That camera exposes its running binary at `GET /api/firmware` (enabled when its
`config_policy` has no embedded secrets — `LOAD_OR_USE_DEFAULT` or `LOAD_OR_FAIL`).

Flow:

1. User enters the peer camera's base URL (e.g. `http://10.0.0.42/`).
2. Normalize to `origin`, fetch `{peer}/api/status` to read `version`, `features.board`, and `id`. Refuse if the peer's
   board doesn't match the local board, or if `peer.id` equals the local device id (self-flashing is pointless and
   confusing).
3. Compare `peer.version` with the local `version` using `compareVersion` and surface that in the UI (e.g. "Peer is
   v1.4.0 — newer than installed v1.3.2"). Let the user flash even when equal or older, but warn.
4. `GET {peer}/api/firmware` to download the blob, then follow the normal confirm-and-flash path.

Open questions / complications that made this not worth shipping yet:

- **Authentication.** If the peer camera requires auth on `/api/firmware`, the browser needs credentials for it. The hub
  page already tracks per-camera auths; the `/ota` page doesn't, so this mode would either require re-entering auth or
  sharing storage with the hub.
- **Double version verification.** The peer's version comes from `/api/status` (cheap, done before the download), but
  the embedded `KIKKER_X_FW_VERSION=` marker is only extracted after the blob is in hand. The two usually agree, but the
  code/UX has to handle the case where they don't — and showing the version twice (once from status, once from the
  marker) is awkward.
- **Board match is fuzzy.** Same problem as hub-based push: the `features.board` string must match exactly, and we have
  no compatible-variants table.

The simpler workaround is `curl http://{peer}/api/firmware -o firmware.bin` + upload through the existing file picker,
which the user can already do today.

---

## Hub-based firmware push

Per-camera "Push firmware" button on each hub card, and/or a global "Update all" action.

Flow per card:

1. Check the card's status: `config_policy`, `allow_ota`, `features.board`, current `version`.
2. Let the user pick a source — a file, a URL, or another KikkerX camera in the hub with matching board type and higher
   version.
3. Upload to `POST {card.url}/api/firmware` with the hub's auth for that camera.

Complications that make this non-trivial:

- Board matching is fuzzy: the `features.board` string must match exactly, and we don't have a way to declare compatible
  variants.
- Different `config_policy` values imply different upgrade semantics (NVS-persisted vs embedded). Pushing a
  `STORE_EMBEDDED`-built binary to a camera that was set up with `LOAD_OR_USE_DEFAULT` would overwrite whatever was in
  NVS.
- Global "Update all" would need to pick _one_ source binary per board type, and that choice isn't obvious when multiple
  cameras of the same board report different versions.
- Progress tracking across multiple uploads, error aggregation, partial failures.

The current "!" button on outdated cards (which links to the card's own `/ota` page) covers the main case with much less
complexity. A hub-side push only pays off when there are many cameras to update, and by then the "upload-once, push via
`GET /api/firmware` from another camera" pattern already works.
