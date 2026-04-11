# video_saver.py — Recording to video

`video_saver.py` records the MJPEG stream or a timelapse to H.264 MP4 files using `ffmpeg`.

Requires `ffmpeg` with libx264 (most distributions ship this). Python dependencies are managed with
[uv](https://docs.astral.sh/uv/) — see [Getting started](getting-started.md).

Always quote the URL — the `?` and `&` in query strings are shell metacharacters and will be misinterpreted if unquoted.

---

## Stream recording

Records live MJPEG, rolling to a new file every hour:

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/stream.mjpeg?res=VGA" \
    --output-dir ./recordings
```

Stream at 5 fps, high compression, roll every 500 MB:

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/stream.mjpeg?res=SVGA" \
    --output-dir ./recordings \
    --fps-cap 5 --quality 28 --encode-preset slow --roll-size-mb 500
```

---

## Timelapse

One frame every 30 seconds, new file every 24 hours:

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/capture.jpg?res=UXGA" \
    --output-dir ./timelapse \
    --timelapse-interval 30s \
    --roll-interval 24h
```

One week timelapse with auth, roll at 500 MB:

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/capture.jpg?res=UXGA" \
    --output-dir ./timelapse \
    --timelapse-interval 1m \
    --total-time 7d \
    --roll-size-mb 500 \
    --auth-user admin
```

---

## Battery-saving timelapse

Pass `--timelapse-sleep-url` to POST a URL after each successful capture — typically `/api/poweroff?duration=N` — to put
the device into timed deep sleep between frames. Use `{{interval}}` in the URL as a placeholder; it is replaced with the
sleep duration in seconds (`--timelapse-interval` minus `--timelapse-sleep-margin`).

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/capture.jpg?res=UXGA" \
    --output-dir ./timelapse \
    --timelapse-interval 5m \
    --roll-interval 24h \
    --timelapse-sleep-url "http://kikker-x.local/api/poweroff?duration={{interval}}" \
    --timelapse-sleep-margin 30s
```

This example sleeps for 270 s (5 min − 30 s), leaving 30 s for boot and WiFi reconnect. The script's retry logic handles
the device being temporarily unreachable while it sleeps; `--timelapse-interval` acts as a minimum gap between frames —
if the device comes up early the script waits out the remainder.

---

## Status logging

Stream with periodic status logging alongside each recording:

```sh
./video_saver.py \
    "http://kikker-x.local/api/cam/stream.mjpeg?res=VGA" \
    --output-dir ./recordings \
    --status-url "/api/status?mode=short_text" \
    --status-interval 5m
```

---

## Flags

| Flag                       | Default | Description                                                                            |
| -------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `--output-dir`             | —       | Directory for output files (required)                                                  |
| `--roll-interval`          | `1h`    | Start a new file after this duration                                                   |
| `--total-time`             | —       | Stop after this total time                                                             |
| `--roll-size-mb`           | —       | Also roll when file exceeds N MB                                                       |
| `--quality`                | `23`    | H.264 CRF (lower = better quality, larger file)                                        |
| `--encode-preset`          | `fast`  | `ultrafast` … `veryslow`                                                               |
| `--fps-cap`                | —       | [stream] Drop frames to stay at or below N fps                                         |
| `--timelapse-interval`     | —       | [timelapse] Capture interval                                                           |
| `--timelapse-fps`          | `25`    | [timelapse] Playback frame rate of output video                                        |
| `--timelapse-sleep-url`    | —       | [timelapse] URL to POST after each frame (device sleep)                                |
| `--timelapse-sleep-margin` | `0s`    | [timelapse] Subtracted from interval for `{{interval}}`                                |
| `--connect-timeout`        | `10`    | Timeout in seconds for the initial HTTP connection                                     |
| `--read-timeout`           | `30`    | Timeout in seconds for receiving data; triggers a retry                                |
| `--retry-delay`            | `2s`    | Initial wait before retrying after an error                                            |
| `--max-retry-delay`        | `1m`    | Exponential backoff cap for retry delay                                                |
| `--auth-user`              | —       | HTTP Basic auth username                                                               |
| `--auth-password`          | —       | Password: literal value, `@/path/to/file`, `@-` (stdin), or prompted on tty if omitted |
| `--status-url`             | —       | URL to fetch periodically and log alongside recordings                                 |
| `--status-interval`        | `10m`   | How often to fetch `--status-url`                                                      |
| `--debug`                  | —       | Print per-frame timing events to stdout                                                |

Press Ctrl-C and wait to stop cleanly — the current segment is finalized before exit.
