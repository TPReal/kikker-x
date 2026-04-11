# Development

## Development server

`fake_server.py` serves the static UI from `src/static/` and simulates all API endpoints — no hardware needed.

```sh
./fake_server.py                        # http://localhost:8080/, Timer Camera X features
./fake_server.py --port 9000            # custom port
./fake_server.py --board wrovercam      # simulate ESP-WROVER-DEV (no battery)
```

`/api/restart` re-executes the server process. `/api/poweroff` shuts it down.

**Auth** — the dev server reads auth settings from the same config file as the firmware (`src/_config.json` if present,
otherwise `configs/default_config.json`). Set the `auth` key:

```json
"auth": {
  "username": "admin",
  "pass_sha256": "<sha256 of password>"
}
```

Generate the hash (password entered without echo):

```sh
IFS= read -rsp 'Password: ' pass && echo && printf '%s' "$pass" | sha256sum | cut -d' ' -f1; unset pass
```

Set `"auth": null` to disable auth.

---

## Formatting

**Format** — clang-format (C++), Biome (JS/HTML/CSS), ruff (Python), prettier (Markdown):

```sh
./format.py
```

---

## Checks

**Check** — Biome lint (JS/HTML/CSS), ruff check (Python), mypy (Python):

```sh
./checks.py
./checks.py --fix   # auto-fix where supported
```
