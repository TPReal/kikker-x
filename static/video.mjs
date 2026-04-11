import { Settings } from "/settings.mjs";
import { docElem } from "/util.mjs";

let retryTimer = null;
let fpsTimer = null;
let currentParams = "";

function startFpsPoll() {
  fpsTimer = setInterval(async () => {
    try {
      const resp = await fetch("/api/streamfps");
      const { fps, active } = await resp.json();
      if (active) {
        docElem.status.textContent = `${fps.toFixed(1)} FPS`;
      }
    } catch (e) {
      // Errors here are expected during reconnect; log at debug level so
      // unexpected failures (e.g. malformed JSON) are still visible.
      console.debug("FPS poll error:", e);
    }
  }, 1500);
}

function applyRotation() {
  settings.applyElementRotation(docElem.streamImg);
}

function startStream(streamParams) {
  currentParams = streamParams;
  clearTimeout(retryTimer);
  clearInterval(fpsTimer);
  fpsTimer = null;
  docElem.status.textContent = "⏳";
  // Lock current rendered size before clearing src so the black background
  // fills the same area and the layout doesn't jump.
  if (docElem.streamImg.naturalWidth) {
    docElem.streamImg.style.width = `${docElem.streamImg.offsetWidth}px`;
    docElem.streamImg.style.height = `${docElem.streamImg.offsetHeight}px`;
  }
  // Clear src so the browser sends a TCP FIN to the old stream immediately,
  // letting the device detect the disconnect and free the camera before the
  // new connection arrives. Hide the element so the broken-image icon doesn't
  // show while src is empty.
  docElem.streamImg.style.visibility = "hidden";
  docElem.streamImg.src = "";
  retryTimer = setTimeout(() => {
    docElem.streamImg.src = `/api/cam/stream.mjpeg${streamParams}&t=${Date.now()}`;
  }, 500);
}

docElem.streamImg.addEventListener("load", () => {
  docElem.streamImg.style.width = "";
  docElem.streamImg.style.height = "";
  docElem.streamImg.style.visibility = "";
  docElem.status.textContent = "Live";
  applyRotation();
  startFpsPoll();
});
docElem.streamImg.addEventListener("error", e => {
  // When src is cleared to '' the browser resolves it to the page URL, which
  // does not contain the stream path — ignore that spurious error event.
  if (!e.target.src.includes("/api/cam/stream.mjpeg")) {
    return;
  }
  clearInterval(fpsTimer);
  fpsTimer = null;
  docElem.status.textContent = "reconnecting…";
  retryTimer = setTimeout(() => startStream(currentParams), 2000);
});

docElem.fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    docElem.canvasArea.requestFullscreen();
  }
});
document.addEventListener("fullscreenchange", () => {
  docElem.fsBtn.textContent = document.fullscreenElement ? "✕" : "⛶";
});
docElem.refreshBtn.addEventListener("click", () => startStream(settings.params()));

window.addEventListener("resize", () => {
  if (docElem.streamImg.naturalWidth) {
    applyRotation();
  }
});

// Clear the stream src on pagehide so the browser closes the TCP connection
// immediately, even when the page is kept in the back-forward cache.
window.addEventListener("pagehide", () => {
  clearTimeout(retryTimer);
  clearInterval(fpsTimer);
  docElem.streamImg.src = "";
});

const settings = new Settings("video", {
  onSettingsChanged: startStream,
  onApplyRotation: applyRotation,
  onPageReady: () => startStream(settings.params()),
});
