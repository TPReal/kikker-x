#!/usr/bin/env -S uv run
"""
video_saver.py — Record an MJPEG stream or timelapse to compressed H.264 video.

The recording mode is auto-detected from the URL's Content-Type:
  • multipart/x-mixed-replace → stream mode  (live MJPEG)
  • image/jpeg                → timelapse mode (repeated still captures)

Requirements:
    pip install requests
    ffmpeg in PATH (with libx264 support)
"""

import argparse
import datetime
import getpass
import urllib.parse
import shutil
import signal
import subprocess
import sys
import threading
import time
import types
from collections.abc import Iterator
from pathlib import Path

try:
    import requests
except ImportError as e:
    print(f"Error: {e}")
    sys.exit("Package not installed. Run:  uv run video_saver.py")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

_DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_DURATION_HINT = "a bare number (seconds) or a suffix: 30s, 10m, 1.5h, 1D"

_EPILOG = """
modes (auto-detected from Content-Type on first connect):

  stream    multipart/x-mixed-replace  —  records live MJPEG video

  timelapse image/jpeg  —  captures one still every --timelapse-interval
              and assembles into a 25 fps video

examples:

  # Live stream, rolling every hour (default):
  %(prog)s "http://cam.local/api/cam/stream.mjpeg?res=VGA" \\
           --output-dir ./recordings

  # Stream capped at 5 fps, high compression, roll every 500 MB:
  %(prog)s "http://cam.local/api/cam/stream.mjpeg?res=SVGA" \\
           --output-dir ./recordings \\
           --fps-cap 5 --quality 28 --encode-preset slow --roll-size-mb 500

  # Timelapse: one frame every 30 s, new file every 24 h:
  %(prog)s "http://cam.local/api/cam/capture.jpg?res=UXGA" \\
           --output-dir ./timelapse --timelapse-interval 30s --roll-interval 24h

  # Timelapse for one week with authentication:
  %(prog)s "http://cam.local/api/cam/capture.jpg?res=UXGA" \\
           --output-dir ./timelapse --timelapse-interval 1m \\
           --total-time 7d --auth-user admin

  # Battery-saving timelapse: device sleeps between frames.
  # {{interval}} is replaced with the sleep duration in seconds (timelapse-interval minus
  # timelapse-sleep-margin).  The script retries automatically until the device
  # wakes and reconnects; --timelapse-interval acts as a minimum gap.
  %(prog)s "http://cam.local/api/cam/capture.jpg?res=UXGA" \\
           --output-dir ./timelapse --timelapse-interval 5m --roll-interval 24h \\
           --timelapse-sleep-url "/api/poweroff?duration={{interval}}" \\
           --timelapse-sleep-margin 30s

"""


def parse_duration(s: str) -> float:
    """Parse a duration string like '3600', '30s', '10.5m', '2h', '1D'."""
    s = s.strip()
    if s and s[-1].lower() in _DURATION_UNITS:
        factor = _DURATION_UNITS[s[-1].lower()]
        try:
            return float(s[:-1]) * factor
        except ValueError:
            pass
    else:
        try:
            return float(s)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(f"invalid duration {s!r} — use {_DURATION_HINT}")


class _Formatter(argparse.ArgumentDefaultsHelpFormatter, argparse.RawDescriptionHelpFormatter):
    pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Record an MJPEG stream or timelapse to compressed H.264 video files.",
        formatter_class=_Formatter,
        epilog=_EPILOG,
    )
    p.add_argument(
        "url",
        metavar="URL",
        help="URL to record (MJPEG stream or single JPEG; mode is auto-detected). Quote the URL to prevent the shell from interpreting '?' and '&'.",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        metavar="DIR",
        help="Directory for output files (created if missing).",
    )
    p.add_argument(
        "--roll-interval",
        type=parse_duration,
        default="1h",
        metavar="DURATION",
        help=f"Start a new file after this duration ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--total-time",
        type=parse_duration,
        default=None,
        metavar="DURATION",
        help=f"Stop after this total recording time ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--roll-size-mb",
        type=float,
        default=None,
        metavar="MB",
        help="Also roll when the current file exceeds N MB.",
    )
    p.add_argument(
        "--quality",
        type=int,
        default=23,
        metavar="CRF",
        help="H.264 CRF (0=lossless, 51=worst; 18-28 is a good range).",
    )
    p.add_argument(
        "--encode-preset",
        default="fast",
        choices=[
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
        ],
        help="H.264 encoding preset: speed vs compression (slower = smaller files).",
    )
    p.add_argument(
        "--fps-cap",
        type=float,
        default=None,
        metavar="FPS",
        help="[stream only] Drop frames arriving faster than this rate.",
    )
    p.add_argument(
        "--timelapse-interval",
        type=parse_duration,
        default=None,
        metavar="DURATION",
        help=f"[timelapse only] Capture one frame every this interval ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--timelapse-fps",
        type=float,
        default=None,
        metavar="FPS",
        help="[timelapse only] Playback frame rate of the output video (default: 25).",
    )
    p.add_argument(
        "--timelapse-sleep-url",
        default=None,
        metavar="URL",
        help="[timelapse only] POST this URL after each successful capture to sleep the device."
        " Use {{interval}} as a placeholder for the sleep duration in seconds"
        " (timelapse-interval minus timelapse-sleep-margin)."
        " A path starting with '/' uses the host from the main URL.",
    )
    p.add_argument(
        "--timelapse-sleep-margin",
        type=parse_duration,
        default="0s",
        metavar="DURATION",
        help=f"[timelapse only] Subtract this from --timelapse-interval to get the {{{{interval}}}} sleep duration"
        f" ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--connect-timeout",
        type=float,
        default=10,
        metavar="SECONDS",
        help="Timeout for the initial HTTP connection.",
    )
    p.add_argument(
        "--read-timeout",
        type=float,
        default=30,
        metavar="SECONDS",
        help="Timeout for receiving data between chunks; triggers a retry.",
    )
    p.add_argument(
        "--retry-delay",
        type=parse_duration,
        default="2s",
        metavar="DURATION",
        help=f"Initial wait before retrying after an error ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--max-retry-delay",
        type=parse_duration,
        default="1m",
        metavar="DURATION",
        help=f"Exponential backoff cap for retry delay ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--auth-user",
        default=None,
        metavar="USER",
        help="HTTP Basic auth username.",
    )
    p.add_argument(
        "--auth-password",
        default=None,
        metavar="PASS",
        help="HTTP Basic auth password (omit to be prompted; note: visible in process list if passed here).",
    )
    p.add_argument(
        "--status-url",
        default=None,
        metavar="URL",
        help="If given, periodically fetch this URL and append the response to a log file alongside each recording."
        " A path starting with '/' uses the host from the main URL."
        " Example: /api/status?mode=short_text",
    )
    p.add_argument(
        "--status-interval",
        type=parse_duration,
        default="10m",
        metavar="DURATION",
        help=f"How often to fetch --status-url ({_DURATION_HINT}).",
    )
    p.add_argument(
        "--debug",
        action="store_true",
        default=False,
        help="Print per-frame arrival/estimation/send events to stdout.",
    )
    args = p.parse_args()
    # argparse does not apply `type` to defaults, so convert string duration defaults.
    for action in p._actions:
        if action.type is parse_duration:
            v = getattr(args, action.dest)
            if isinstance(v, str):
                setattr(args, action.dest, parse_duration(v))
    return args


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        m, s = divmod(seconds, 60)
        return f"{m}m {s}s" if s else f"{m}m"
    h, remainder = divmod(seconds, 3600)
    m = remainder // 60
    return f"{h}h {m}m" if m else f"{h}h"


def log(msg: str) -> None:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def new_segment_paths(output_dir: Path) -> tuple[Path, Path]:
    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    return output_dir / f"video-{ts}.mp4", output_dir / f"status-{ts}.txt"


def build_ffmpeg_cmd(
    output_path: Path,
    quality: int,
    encode_preset: str,
    use_wallclock: bool = False,
    input_fps: float | None = None,
) -> list[str]:
    cmd = ["ffmpeg", "-loglevel", "warning"]
    # Stream mode: each frame gets a PTS equal to the wall-clock time when ffmpeg
    # reads it from stdin.  Because the consumer writes at a controlled rate the
    # timestamps are evenly spaced and playback speed matches real time.
    if use_wallclock:
        cmd += ["-use_wallclock_as_timestamps", "1"]
    # Timelapse mode: assign consecutive timestamps at the desired playback rate
    # so each captured still occupies exactly one frame in the output video.
    if input_fps is not None:
        cmd += ["-framerate", str(input_fps)]
    cmd += [
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-crf",
        str(quality),
        "-preset",
        encode_preset,
        "-movflags",
        "+faststart",
    ]
    if use_wallclock:
        # Pass wallclock timestamps through as-is (VFR).  Without this ffmpeg
        # defaults to CFR at 25 fps and duplicates frames to pad the gap between
        # the camera's actual rate and 25 fps, producing "more than N frames
        # duplicated" warnings and a bloated output file.
        cmd += ["-fps_mode", "vfr"]
    cmd.append(str(output_path))
    return cmd


def fetch_and_log_status(
    status_url: str,
    log_path: Path | None,
    auth: tuple[str, str] | None,
    connect_timeout: float,
    read_timeout: float,
    debug: bool = False,
) -> None:
    """Fetch status_url and append the result (or error) to log_path. Never raises."""
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if debug:
        print(f"REQUEST GET  {status_url}", flush=True)
    try:
        resp = requests.get(status_url, timeout=(connect_timeout, read_timeout), auth=auth)
        if debug:
            print(
                f"RESPONSE {resp.status_code}  {len(resp.content)}B  {resp.headers.get('content-type', '')}", flush=True
            )
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "").lower()
        if ct.startswith("text/") or ct == "application/json":
            entry = f"[{ts}] {resp.text.strip()}\n"
        else:
            msg = f"Status URL returned non-text content-type {ct!r}"
            log(msg)
            entry = f"[{ts}] {msg}\n"
    except Exception as e:
        msg = f"Status fetch failed: {e}"
        log(msg)
        entry = f"[{ts}] {msg}\n"
    if log_path is not None:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)


def call_sleep_url(
    url_template: str,
    sleep_secs: float,
    auth: tuple[str, str] | None,
    connect_timeout: float,
    debug: bool = False,
) -> None:
    """POST the sleep URL with {{interval}} substituted by sleep_secs. Never raises."""
    url = url_template.replace("{{interval}}", str(int(sleep_secs)))
    if debug:
        print(f"REQUEST POST {url}", flush=True)
    try:
        resp = requests.post(url, timeout=connect_timeout, auth=auth)
        if debug:
            print(f"RESPONSE {resp.status_code}  {len(resp.content)}B", flush=True)
        resp.raise_for_status()
    except Exception as e:
        log(f"Sleep URL failed: {e}")


def probe_url(url: str, auth: tuple[str, str] | None, connect_timeout: float) -> tuple[str, requests.Response | None]:
    """
    Connect to the URL and return (mode, resp) based on Content-Type.
    mode is 'stream' or 'image'.  For stream mode the response is kept open
    so the caller can hand it directly to record_stream_segment; for image mode it is closed
    and None is returned.  Exits with an error if the URL is unreachable or
    the Content-Type is unrecognised.
    """
    log(f"Probing: {url}")
    try:
        resp = requests.get(url, stream=True, timeout=connect_timeout, auth=auth)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "").lower()
    except Exception as e:
        sys.exit(f"Failed to probe URL: {e}")

    if "multipart" in ct:
        return "stream", resp
    resp.close()
    if "image/" in ct:
        return "image", None
    sys.exit(
        f"Unrecognised Content-Type {ct!r}.\nExpected multipart/x-mixed-replace (stream) or image/jpeg (timelapse)."
    )


def iter_jpeg_frames(resp: "requests.Response") -> Iterator[tuple[bytes, bool]]:
    """
    Yield (frame, has_more) from a streaming multipart MJPEG response.
    Frames are located by JPEG SOI (FF D8) and EOI (FF D9) markers.

    has_more is True when another complete frame is already in the receive
    buffer without needing a new socket read.  This signals that the consumer
    is falling behind; the caller should consider dropping the frame to catch up.

    Uses read1() on the underlying BufferedReader so each call issues a single
    recv() and returns immediately with whatever the kernel has, matching the
    browser's behaviour.  Falls back to iter_content on AttributeError.
    """
    SOI = b"\xff\xd8"
    EOI = b"\xff\xd9"
    buf = b""

    try:
        _fp = resp.raw._fp.fp  # type: ignore[attr-defined, union-attr]

        def _read() -> bytes:
            return _fp.read1(65536)

    except AttributeError:
        _it = resp.iter_content(chunk_size=4096)

        def _read() -> bytes:
            try:
                return next(_it)
            except StopIteration:
                return b""

    while True:
        chunk = _read()
        if not chunk:
            break
        buf += chunk

        while True:
            start = buf.find(SOI)
            if start == -1:
                buf = b""
                break

            end = buf.find(EOI, start + 2)
            if end == -1:
                if start > 0:
                    buf = buf[start:]
                break

            frame = buf[start : end + 2]
            buf = buf[end + 2 :]
            s2 = buf.find(SOI)
            has_more = s2 != -1 and buf.find(EOI, s2 + 2) != -1
            yield frame, has_more


def finalize_ffmpeg(proc: subprocess.Popen, output_path: Path, frame_count: int, elapsed: float) -> None:
    """Close ffmpeg's stdin and wait for it to write the final MP4 structure."""
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        log("Warning: ffmpeg did not finish within 60s — terminating.")
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log("Warning: ffmpeg did not respond to SIGTERM — killing.")
            proc.kill()
            proc.wait()
    size_mb = output_path.stat().st_size / 1_048_576 if output_path.exists() else 0
    log(f"Segment done: {frame_count} frames, {elapsed:.0f}s, {size_mb:.1f} MB  ({output_path.name})")
    if proc.returncode not in (0, None):
        log(f"Warning: ffmpeg exited with code {proc.returncode}")


# ---------------------------------------------------------------------------
# Stream recording
# ---------------------------------------------------------------------------

_ROLL = "roll"
_STOP = "stop"
_ERROR = "error"


def connect_stream(
    url: str,
    auth: tuple[str, str] | None,
    connect_timeout: float,
    read_timeout: float,
) -> requests.Response | None:
    """Open an MJPEG HTTP connection. Returns None on failure."""
    log(f"Connecting: {url}")
    try:
        resp = requests.get(url, stream=True, timeout=(connect_timeout, read_timeout), auth=auth)
        resp.raise_for_status()
        return resp
    except Exception as e:
        log(f"Connection failed: {e}")
        return None


def record_stream_segment(
    resp: requests.Response,
    output_path: Path,
    ffmpeg_cmd: list[str],
    roll_interval: float,
    max_size_bytes: float | None,
    stop_flag: list[bool],
    fps_cap: float | None,
    auth: tuple[str, str] | None,
    connect_timeout: float,
    read_timeout: float,
    status_url: str | None = None,
    status_interval: float = 600.0,
    status_log_path: Path | None = None,
    debug: bool = False,
) -> str:
    """Record one segment from a live MJPEG stream.

    Frames are read directly from the HTTP response and written to ffmpeg's
    stdin with no intermediate buffer.  A frame is dropped when has_more is
    True (another frame is already waiting in the socket buffer, meaning the
    consumer fell behind) or when fps_cap is set and the frame arrived too
    soon.  Drops are logged.

    ffmpeg uses -use_wallclock_as_timestamps so each written frame's PTS is the
    wall-clock time of the write, giving correct VFR playback.

    resp is not closed on roll — the caller keeps it alive for the next segment
    and must close it on _ERROR or _STOP.
    """
    try:
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception as e:
        log(f"Failed to start ffmpeg: {e}")
        return _ERROR
    assert proc.stdin is not None

    log(f"Recording → {output_path.name}")
    segment_start = time.monotonic()
    last_send = segment_start
    frame_count = 0  # frames written to ffmpeg
    frame_index = 0  # every frame received, including dropped
    drop_count = 0  # drops since last SEND
    segment_done = threading.Event()

    if status_url is not None:
        _status_url: str = status_url

        def _status_thread() -> None:
            last = time.monotonic() - status_interval
            while True:
                wait = max(0.0, last + status_interval - time.monotonic())
                if segment_done.wait(timeout=wait):
                    break
                fetch_and_log_status(_status_url, status_log_path, auth, connect_timeout, read_timeout, debug=debug)
                last = time.monotonic()

        threading.Thread(target=_status_thread, daemon=True, name="status-fetcher").start()

    _DBG_INTERVAL = 2.0
    dbg_prev_t = segment_start
    dbg_prev_index = 0
    dbg_prev_count = 0
    result = _ERROR

    try:
        for frame, has_more in iter_jpeg_frames(resp):
            frame_index += 1
            now = time.monotonic()

            if stop_flag[0]:
                result = _STOP
                break
            if now - segment_start >= roll_interval:
                result = _ROLL
                break
            if max_size_bytes and output_path.exists() and output_path.stat().st_size >= max_size_bytes:
                result = _ROLL
                break

            if has_more or (fps_cap is not None and now - last_send < 1.0 / fps_cap):
                drop_count += 1
                continue

            if debug and drop_count > 0:
                print(f"DROP    {drop_count} frame(s)", flush=True)
            drop_count = 0

            try:
                proc.stdin.write(frame)
                frame_count += 1
                if debug:
                    print(
                        f"SEND    t={now:.3f}  dt={(now - last_send) * 1000:.1f}ms  frame={frame_count}",
                        flush=True,
                    )
                last_send = now
            except BrokenPipeError:
                log("ffmpeg pipe closed unexpectedly")
                break

            if debug and now - dbg_prev_t >= _DBG_INTERVAL:
                dt = now - dbg_prev_t
                print(
                    f"FPS     t={now:.3f}"
                    f"  arrived={(frame_index - dbg_prev_index) / dt:.1f}/s"
                    f"  sent={(frame_count - dbg_prev_count) / dt:.1f}/s",
                    flush=True,
                )
                dbg_prev_t = now
                dbg_prev_index = frame_index
                dbg_prev_count = frame_count

    except Exception as e:
        if stop_flag[0]:
            result = _STOP
        else:
            log(f"Stream error: {e}")
    finally:
        segment_done.set()
        elapsed = time.monotonic() - segment_start
        finalize_ffmpeg(proc, output_path, frame_count, elapsed)

    return result


# ---------------------------------------------------------------------------
# Timelapse recording
# ---------------------------------------------------------------------------


def record_timelapse_segment(
    image_url: str,
    output_path: Path,
    ffmpeg_cmd: list[str],
    roll_interval: float,
    max_size_bytes: float | None,
    timelapse_interval: float,
    connect_timeout: float,
    read_timeout: float,
    stop_flag: list[bool],
    auth: tuple[str, str] | None,
    retry_delay: float,
    max_retry_delay: float,
    status_url: str | None = None,
    status_interval: float = 600.0,
    status_log_path: Path | None = None,
    sleep_url: str | None = None,
    sleep_margin: float = 0.0,
    debug: bool = False,
) -> str:
    """Capture stills at a fixed interval and encode them into one segment."""
    try:
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception as e:
        log(f"Failed to start ffmpeg: {e}")
        return _ERROR
    assert proc.stdin is not None

    log(f"Recording timelapse → {output_path.name}  (1 frame / {fmt_duration(timelapse_interval)})")
    segment_start = time.monotonic()
    frame_count = 0
    result = _ERROR
    last_status_time = time.monotonic() - status_interval  # fetch on first successful frame

    try:
        while not stop_flag[0]:
            elapsed = time.monotonic() - segment_start
            if elapsed >= roll_interval:
                result = _ROLL
                break

            if max_size_bytes and output_path.exists():
                if output_path.stat().st_size >= max_size_bytes:
                    result = _ROLL
                    break

            # Retry loop for this frame.  attempt_start anchors the timelapse interval.
            frame_retry_delay = retry_delay
            broken_pipe = False
            attempt_start = time.monotonic()
            while not stop_flag[0]:
                try:
                    if debug:
                        print(f"REQUEST GET  {image_url}  t={time.monotonic():.3f}", flush=True)
                    resp = requests.get(
                        image_url,
                        timeout=(connect_timeout, read_timeout),
                        auth=auth,
                    )
                    resp.raise_for_status()
                    data = resp.content
                    if debug:
                        print(f"RESPONSE {resp.status_code}  {len(data)}B  t={time.monotonic():.3f}", flush=True)
                    # Trim to JPEG boundaries in case of any HTTP framing bytes.
                    soi = data.find(b"\xff\xd8")
                    eoi = data.rfind(b"\xff\xd9")
                    if soi != -1 and eoi != -1:
                        data = data[soi : eoi + 2]
                    if debug:
                        print(
                            f"SEND    t={time.monotonic():.3f}  frame={frame_count + 1}  size={len(data)}B", flush=True
                        )
                    proc.stdin.write(data)
                    frame_count += 1
                    break  # success
                except BrokenPipeError:
                    log("ffmpeg pipe closed unexpectedly")
                    broken_pipe = True
                    break
                except Exception as e:
                    log(f"Capture error (retrying in {fmt_duration(frame_retry_delay)}): {e}")
                    deadline = time.monotonic() + frame_retry_delay
                    while not stop_flag[0] and time.monotonic() < deadline:
                        time.sleep(0.1)
                    attempt_start = time.monotonic()
                    frame_retry_delay = min(frame_retry_delay * 2, max_retry_delay)

            if broken_pipe or stop_flag[0]:
                break

            # Fetch status if due, then trigger device sleep — both after successful capture.
            now = time.monotonic()
            if status_url is not None and now - last_status_time >= status_interval:
                fetch_and_log_status(status_url, status_log_path, auth, connect_timeout, read_timeout, debug=debug)
                last_status_time = time.monotonic()
            if sleep_url is not None:
                sleep_secs = timelapse_interval - sleep_margin
                if sleep_secs > 0:
                    call_sleep_url(sleep_url, sleep_secs, auth, connect_timeout, debug=debug)
                else:
                    log("Sleep URL skipped: sleep duration is zero or negative.")

            # Interruptible wait until the next capture is due.
            next_capture = attempt_start + timelapse_interval
            while not stop_flag[0]:
                remaining = next_capture - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(0.1, remaining))

        if stop_flag[0]:
            result = _STOP
    except Exception as e:
        log(f"Timelapse error: {e}")
        result = _ERROR
    finally:
        elapsed = time.monotonic() - segment_start
        finalize_ffmpeg(proc, output_path, frame_count, elapsed)

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _resolve_url(path_or_url: str, base_url: str) -> str:
    """If path_or_url starts with '/', prepend the scheme+host from base_url."""
    if path_or_url.startswith("/"):
        parsed = urllib.parse.urlparse(base_url)
        return f"{parsed.scheme}://{parsed.netloc}{path_or_url}"
    return path_or_url


def main() -> None:
    args = parse_args()

    if args.timelapse_sleep_url is not None:
        args.timelapse_sleep_url = _resolve_url(args.timelapse_sleep_url, args.url)
    if args.status_url is not None:
        args.status_url = _resolve_url(args.status_url, args.url)

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found in PATH.  Please install ffmpeg.")

    # Validate flag combinations before asking for a password.
    # Mode is inferred from --timelapse-interval: present → image, absent → stream.
    # The probe below will confirm the actual Content-Type and error on a mismatch.
    if args.timelapse_interval is None:
        if args.timelapse_fps is not None:
            sys.exit("--timelapse-fps is not allowed for stream URLs (got MJPEG).")
        if args.timelapse_sleep_url is not None:
            sys.exit("--timelapse-sleep-url is not allowed for stream URLs (got MJPEG).")
        if args.timelapse_sleep_margin:
            sys.exit("--timelapse-sleep-margin is not allowed for stream URLs (got MJPEG).")
    else:
        if args.fps_cap is not None:
            sys.exit("--fps-cap is not allowed for timelapse URLs (got image/jpeg).")

    if args.auth_user and not args.auth_password:
        args.auth_password = getpass.getpass(f"Password for {args.auth_user}: ")
    auth: tuple[str, str] | None = (args.auth_user, args.auth_password or "") if args.auth_user else None

    mode, probe_resp = probe_url(args.url, auth, args.connect_timeout)
    log(f"Detected mode    : {mode}")

    if mode == "stream" and args.timelapse_interval is not None:
        sys.exit("URL is an MJPEG stream but --timelapse-interval was given; remove it for stream recording.")
    if mode == "image" and args.timelapse_interval is None:
        sys.exit("URL is an image endpoint; --timelapse-interval is required for timelapse mode.")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    max_size_bytes = args.roll_size_mb * 1_048_576 if args.roll_size_mb else None
    max_total_seconds = args.total_time
    retry_delay = args.retry_delay
    stop_flag: list[bool] = [False]
    active_resp: list[requests.Response | None] = [None]

    def handle_signal(sig: int, frame: types.FrameType | None) -> None:
        log("Stop signal received — finishing current segment then exiting.")
        stop_flag[0] = True
        r = active_resp[0]
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    log(f"Output directory : {output_dir}")
    if max_total_seconds:
        log(f"Total time       : {fmt_duration(max_total_seconds)}")
    roll = [
        t
        for t in [
            (f"size: {args.roll_size_mb} MB" if args.roll_size_mb else None),
            (
                f"time: {fmt_duration(args.roll_interval)}"
                if args.roll_interval and args.roll_interval < (max_total_seconds or float("inf"))
                else None
            ),
        ]
        if t
    ]
    if roll:
        log(f"Roll             : {', '.join(roll)}")
    if mode == "stream":
        log(
            f"Quality          : CRF={args.quality}, encode-preset={args.encode_preset}"
            + (f", fps cap: {args.fps_cap}" if args.fps_cap else "")
        )
    else:
        timelapse_fps = args.timelapse_fps or 25.0
        log(
            f"Quality          : CRF={args.quality}, encode-preset={args.encode_preset}"
            f", timelapse interval: {fmt_duration(args.timelapse_interval or 0.0)}"
            f", playback fps: {timelapse_fps:g}"
        )
    if args.status_url:
        log(f"Status URL       : {args.status_url}  (every {fmt_duration(args.status_interval)})")
    if args.timelapse_sleep_url:
        sleep_secs = max(0.0, (args.timelapse_interval or 0.0) - args.timelapse_sleep_margin)
        log(
            f"Sleep URL        : {args.timelapse_sleep_url}  (sleep {fmt_duration(sleep_secs)}, margin {fmt_duration(args.timelapse_sleep_margin)})"
        )
        if args.timelapse_sleep_margin >= (args.timelapse_interval or 0.0):
            log("Warning: --timelapse-sleep-margin >= --timelapse-interval; sleep duration will be 0")
    elif args.timelapse_sleep_margin:
        log("Warning: --timelapse-sleep-margin has no effect without --timelapse-sleep-url")

    stream: requests.Response | None = probe_resp
    if stream is not None:
        active_resp[0] = stream

    if max_total_seconds is not None:

        def _time_limit_thread() -> None:
            time.sleep(max_total_seconds)
            if not stop_flag[0]:
                log("Total time limit reached.")
                stop_flag[0] = True
                r = active_resp[0]
                if r is not None:
                    try:
                        r.close()
                    except Exception:
                        pass

        threading.Thread(target=_time_limit_thread, daemon=True, name="time-limit").start()

    while not stop_flag[0]:
        effective_roll = args.roll_interval

        output_path, seg_status_log_path = new_segment_paths(output_dir)

        if mode == "stream":
            if stream is None:
                stream = connect_stream(args.url, auth, args.connect_timeout, args.read_timeout)
                if stream is not None:
                    active_resp[0] = stream
            if stream is None:
                result = _ERROR
            else:
                ffmpeg_cmd = build_ffmpeg_cmd(output_path, args.quality, args.encode_preset, use_wallclock=True)
                result = record_stream_segment(
                    resp=stream,
                    output_path=output_path,
                    ffmpeg_cmd=ffmpeg_cmd,
                    roll_interval=effective_roll,
                    max_size_bytes=max_size_bytes,
                    stop_flag=stop_flag,
                    fps_cap=args.fps_cap,
                    auth=auth,
                    connect_timeout=args.connect_timeout,
                    read_timeout=args.read_timeout,
                    status_url=args.status_url,
                    status_interval=args.status_interval,
                    status_log_path=seg_status_log_path if args.status_url else None,
                    debug=args.debug,
                )
                if result in (_ERROR, _STOP):
                    try:
                        stream.close()
                    except Exception:
                        pass
                    stream = None
                    active_resp[0] = None
        else:
            ffmpeg_cmd = build_ffmpeg_cmd(
                output_path, args.quality, args.encode_preset, input_fps=args.timelapse_fps or 25.0
            )
            result = record_timelapse_segment(
                image_url=args.url,
                output_path=output_path,
                ffmpeg_cmd=ffmpeg_cmd,
                roll_interval=effective_roll,
                max_size_bytes=max_size_bytes,
                timelapse_interval=args.timelapse_interval or 0.0,
                connect_timeout=args.connect_timeout,
                read_timeout=args.read_timeout,
                stop_flag=stop_flag,
                auth=auth,
                retry_delay=args.retry_delay,
                max_retry_delay=args.max_retry_delay,
                status_url=args.status_url,
                status_interval=args.status_interval,
                status_log_path=seg_status_log_path if args.status_url else None,
                sleep_url=args.timelapse_sleep_url,
                sleep_margin=args.timelapse_sleep_margin,
                debug=args.debug,
            )

        if result == _ROLL:
            retry_delay = args.retry_delay
        elif result == _ERROR and not stop_flag[0]:
            log(f"Retrying in {fmt_duration(retry_delay)}…")
            deadline = time.monotonic() + retry_delay
            while not stop_flag[0] and time.monotonic() < deadline:
                time.sleep(0.1)
            retry_delay = min(retry_delay * 2, args.max_retry_delay)

    if stream is not None:
        try:
            stream.close()
        except Exception:
            pass

    log("Done.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", flush=True)
        sys.exit(130)
