import { Settings } from "/settings.mjs";
import { docElem } from "/util.mjs";

const ctx = docElem.canvas.getContext("2d");

let photoInFlight = false;

function applyRotation() {
  settings.applyElementRotation(docElem.canvas);
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
    docElem.status.textContent = "Capturing...";
    try {
      const resp = await fetch(`/api/cam/capture.jpg${qs}&t=${Date.now()}`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      docElem.canvas.width = bitmap.width;
      docElem.canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      applyRotation();
      docElem.status.textContent = "Ready";
    } catch (e) {
      console.error("Photo error:", e);
      docElem.status.textContent = "Error";
    }
    qs = pendingParams;
  }
  photoInFlight = false;
}

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
docElem.refreshBtn.addEventListener("click", () => takePhoto(settings.params()));

window.addEventListener("resize", () => {
  if (docElem.canvas.width) {
    applyRotation();
  }
});

const settings = new Settings("photo", {
  onSettingsChanged: takePhoto,
  onApplyRotation: applyRotation,
  onPageReady: () => takePhoto(settings.params()),
});
