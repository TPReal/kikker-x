# Configuration

At build time, `build_helpers/prepare_config.py` reads and shallow-merges one or more JSON files into
`src/_config.json`, which is then embedded in the firmware via INCBIN.

## Config schema

See `config.json.template` in this directory for all fields and their documentation.

## Specifying config files

Each PlatformIO environment specifies its config files via `custom_config_files` (newline-separated list of paths).
Files are merged in order — later files overwrite top-level keys from earlier ones. The default (in `platformio.ini` in
repo root) is:

```ini
[env:kikker-x-default]
extends = kikker-x
custom_config_files = configs/default_config.json
```

## Adding custom configurations

1. Create JSON config files under `configs/custom/` (gitignored).

2. Copy `configs/platformio.ini.template` to `configs/platformio.ini` (also gitignored) and add environments that layer
   your files on top of the defaults. For example:

   ```ini
   [env:kikker-x-living-room]
   extends = kikker-x
   custom_config_files =
       configs/default_config.json
       configs/custom/home_config.json
       configs/custom/living_room_config.json

   [env:kikker-x-bedroom]
   extends = kikker-x
   custom_config_files =
       configs/default_config.json
       configs/custom/home_config.json
       configs/custom/bedroom_config.json
   ```

   In this example:
   - `configs/default_config.json` is the base config, might be optional,
   - `configs/custom/home_config.json` defines the WiFi networks and login credentials,
   - `configs/custom/living_room_config.json` and `configs/custom/bedroom_config.json` define the camera-specific
     settings, like mDNS (camera name).

3. Build or upload the desired environment: `pio run -e kikker-x-living-room` and `pio run -e kikker-x-bedroom`.
