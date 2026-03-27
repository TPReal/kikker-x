import { Settings } from "/settings.mjs";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

let photoInFlight = false;

function applyRotation() {
  settings.applyElementRotation(canvas);
}

let pendingParams = null;

// Queue-based photo fetch: if a capture is already in progress, remember
// the latest params and take another photo immediately after it finishes.
// This avoids aborting mid-transfer (which causes ERR_CONNECTION_RESET on
// the ESP32) while still always showing the most up-to-date settings.
async function takePhoto(queryString) {
  if (photoInFlight) {
    pendingParams = queryString;
    return;
  }
  photoInFlight = true;
  let qs = queryString;
  while (qs !== null) {
    pendingParams = null;
    statusEl.textContent = "Capturing...";
    try {
      const resp = await fetch(`/api/cam/capture.jpg${qs}&t=${Date.now()}`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      applyRotation();
      statusEl.textContent = "Ready";
    } catch (e) {
      console.error("Photo error:", e);
      statusEl.textContent = "Error";
    }
    qs = pendingParams;
  }
  photoInFlight = false;
}

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
document.getElementById("refresh-btn").addEventListener("click", () => takePhoto(settings.params()));

window.addEventListener("resize", () => {
  if (canvas.width) {
    applyRotation();
  }
});

const settings = new Settings("photo", {
  onSettingsChanged: takePhoto,
  onApplyRotation: applyRotation,
  onPageReady: () => takePhoto(settings.params()),
});
