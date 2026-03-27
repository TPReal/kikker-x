import { Settings } from "/settings.mjs";

const imgEl = document.getElementById("stream-img");
const statusEl = document.getElementById("status");
let retryTimer = null;
let fpsTimer = null;
let currentParams = "";

function startFpsPoll() {
  fpsTimer = setInterval(async () => {
    try {
      const resp = await fetch("/api/streamfps");
      const { fps, active } = await resp.json();
      if (active) {
        statusEl.textContent = `${fps.toFixed(1)} FPS`;
      }
    } catch (e) {
      // Errors here are expected during reconnect; log at debug level so
      // unexpected failures (e.g. malformed JSON) are still visible.
      console.debug("FPS poll error:", e);
    }
  }, 1500);
}

function applyRotation() {
  settings.applyElementRotation(imgEl);
}

function startStream(streamParams) {
  currentParams = streamParams;
  clearTimeout(retryTimer);
  clearInterval(fpsTimer);
  fpsTimer = null;
  statusEl.textContent = "⏳";
  // Lock current rendered size before clearing src so the black background
  // fills the same area and the layout doesn't jump.
  if (imgEl.naturalWidth) {
    imgEl.style.width = `${imgEl.offsetWidth}px`;
    imgEl.style.height = `${imgEl.offsetHeight}px`;
  }
  // Clear src so the browser sends a TCP FIN to the old stream immediately,
  // letting the device detect the disconnect and free the camera before the
  // new connection arrives. Hide the element so the broken-image icon doesn't
  // show while src is empty.
  imgEl.style.visibility = "hidden";
  imgEl.src = "";
  retryTimer = setTimeout(() => {
    imgEl.src = `/api/cam/stream.mjpeg${streamParams}&t=${Date.now()}`;
  }, 500);
}

imgEl.addEventListener("load", () => {
  imgEl.style.width = "";
  imgEl.style.height = "";
  imgEl.style.visibility = "";
  statusEl.textContent = "Live";
  applyRotation();
  startFpsPoll();
});
imgEl.addEventListener("error", e => {
  // When src is cleared to '' the browser resolves it to the page URL, which
  // does not contain the stream path — ignore that spurious error event.
  if (!e.target.src.includes("/api/cam/stream.mjpeg")) {
    return;
  }
  clearInterval(fpsTimer);
  fpsTimer = null;
  statusEl.textContent = "reconnecting…";
  retryTimer = setTimeout(() => startStream(currentParams), 2000);
});

document.getElementById("fs-btn").addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.getElementById("canvas-area").requestFullscreen();
  }
});
document.addEventListener("fullscreenchange", () => {
  document.getElementById("fs-btn").textContent = document.fullscreenElement ? "✕" : "⛶";
});
document.getElementById("refresh-btn").addEventListener("click", () => startStream(settings.params()));

window.addEventListener("resize", () => {
  if (imgEl.naturalWidth) {
    applyRotation();
  }
});

// Clear the stream src on pagehide so the browser closes the TCP connection
// immediately, even when the page is kept in the back-forward cache.
window.addEventListener("pagehide", () => {
  clearTimeout(retryTimer);
  clearInterval(fpsTimer);
  imgEl.src = "";
});

const settings = new Settings("video", {
  onSettingsChanged: startStream,
  onApplyRotation: applyRotation,
  onPageReady: () => startStream(settings.params()),
});
