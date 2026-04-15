import { docElem } from "/util.mjs";

const RELOAD_DELAY_MS = 8000;

// First byte of every ESP32 image is 0xE9. We treat a byte-0 mismatch as a
// hard "not a firmware image" signal. The KikkerX version marker placed in
// .rodata by the firmware is scanned across the whole blob — its file offset
// is not predictable, so "scan the first N KB" would be unreliable.
const IMAGE_MAGIC = 0xe9;
const VERSION_MARKER = "KIKKER_X_FW_VERSION=";
const VERSION_MAX = 31;

function setStatus(message, path = undefined) {
  docElem.otaStatus.textContent = message || "";
  docElem.otaPath.hidden = !path;
  docElem.otaPath.textContent = path || "";
}

function setFileVersion(text) {
  docElem.otaFileVersion.hidden = !text;
  docElem.otaFileVersion.textContent = text || "";
}

// Returns {version}, {invalid: true} if the image magic is wrong, or {} if
// the image looks valid but no KikkerX version marker was found.
async function inspectFirmware(blob) {
  try {
    if (!blob.size) {
      return { invalid: true };
    }
    const firstByte = new Uint8Array(await blob.slice(0, 1).arrayBuffer())[0];
    if (firstByte !== IMAGE_MAGIC) {
      return { invalid: true };
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const marker = new TextEncoder().encode(VERSION_MARKER);
    const idx = findBytes(bytes, marker);
    if (idx === -1) {
      return {};
    }
    const start = idx + marker.length;
    let end = start;
    while (end < bytes.length && end - start < VERSION_MAX && bytes[end] !== 0) {
      end++;
    }
    if (end === start) {
      return {};
    }
    return { version: new TextDecoder().decode(bytes.subarray(start, end)) };
  } catch {
    return {};
  }
}

function findBytes(haystack, needle) {
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function firmwareLabel(info) {
  if (info.invalid) {
    return "Not a valid firmware image.";
  }
  if (info.version) {
    return `Firmware: v${info.version}`;
  }
  return "Firmware: (not detected)";
}

function firmwareConfirmLine(info) {
  if (info.invalid) {
    return "NOT a valid firmware image.\n";
  }
  if (info.version) {
    return `Version: v${info.version}\n`;
  }
  return "Version: (not detected)\n";
}

async function loadCurrentVersion() {
  try {
    const res = await fetch("/api/status");
    const status = await res.json();
    docElem.otaBoard.textContent = status.features?.board || "unknown";
    docElem.otaCurrentVersion.textContent = status.version ? `v${status.version}` : "unknown";
    const noSecrets = status.config_policy === "LOAD_OR_USE_DEFAULT" || status.config_policy === "LOAD_OR_FAIL";
    docElem.otaDownload.hidden = !noSecrets;
    if (status.allow_ota === false) {
      docElem.otaDisabled.hidden = false;
      docElem.otaModeRow.style.display = "none";
      docElem.otaFileSection.style.display = "none";
    }
  } catch {
    docElem.otaBoard.textContent = "unknown";
    docElem.otaCurrentVersion.textContent = "unknown";
  }
}

function uploadBlob(blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/firmware");
    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable) {
        setStatus(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 200) {
        resolve(xhr.responseText);
      } else {
        reject(new Error(`Error ${xhr.status}: ${xhr.responseText}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed (network error).")));
    xhr.send(blob);
  });
}

function onFlashDone(msg) {
  setStatus(`${msg} Reloading soon…`);
  setTimeout(() => {
    location.href = "/";
  }, RELOAD_DELAY_MS);
}

function updateButtonStates() {
  docElem.otaBtn.disabled = !selectedFile;
  docElem.otaFetchBtn.disabled = !docElem.otaUrl.value.trim();
}

function setBusy(busy) {
  if (busy) {
    docElem.otaBtn.disabled = true;
    docElem.otaFetchBtn.disabled = true;
  } else {
    updateButtonStates();
  }
}

let selectedFile = null;

function setSelectedFile(file) {
  selectedFile = file;
  updateButtonStates();
  if (!file) {
    setFileVersion(undefined);
    return;
  }
  setFileVersion("Parsing…");
  inspectFirmware(file).then(info => {
    if (selectedFile === file) {
      setFileVersion(firmwareLabel(info));
    }
  });
}

docElem.otaFile.addEventListener("change", () => {
  if (docElem.otaFile.files[0]) {
    setSelectedFile(docElem.otaFile.files[0]);
    setStatus(undefined);
  } else if (selectedFile) {
    const dt = new DataTransfer();
    dt.items.add(selectedFile);
    docElem.otaFile.files = dt.files;
  }
});

docElem.otaUrl.addEventListener("input", () => {
  updateButtonStates();
  setStatus(undefined);
});

async function flash(blob) {
  setStatus("Uploading…");
  try {
    onFlashDone(await uploadBlob(blob));
  } catch (e) {
    setStatus(e.message);
  }
}

async function doUploadFile() {
  if (!selectedFile) {
    return;
  }
  const info = await inspectFirmware(selectedFile);
  const sizeKb = Math.round(selectedFile.size / 1024);
  if (
    !confirm(
      `Upload ${selectedFile.name}\n${firmwareConfirmLine(info)}Size: ${sizeKb} KB\n\nThis will reboot the device.`,
    )
  ) {
    return;
  }
  setBusy(true);
  try {
    await flash(selectedFile);
  } finally {
    setBusy(false);
  }
}

async function fetchAndFlash(url, label) {
  setStatus("Downloading firmware…");
  let blob;
  try {
    const res = await fetch(url);
    if (res.status === 403) {
      setStatus(`Source refused: ${await res.text()}`);
      return;
    }
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    const total = Number(res.headers.get("Content-Length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loaded += value.length;
      setStatus(
        total ? `Downloading… ${Math.round((loaded / total) * 100)}%` : `Downloading… ${Math.round(loaded / 1024)} KB`,
      );
    }
    blob = new Blob(chunks);
  } catch (e) {
    setStatus(e instanceof TypeError ? "Fetch failed (network error or CORS)." : e.message);
    return;
  }
  const info = await inspectFirmware(blob);
  const sizeKb = Math.round(blob.size / 1024);
  if (
    !confirm(
      `Flash firmware from ${label}\n${firmwareConfirmLine(info)}Size: ${sizeKb} KB\n\nThis will reboot the device.`,
    )
  ) {
    setStatus(undefined);
    return;
  }
  await flash(blob);
}

async function doFetchAndUpload() {
  const url = docElem.otaUrl.value.trim();
  if (!url) {
    return;
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    setStatus("URL must start with http:// or https://.");
    return;
  }
  setBusy(true);
  try {
    await fetchAndFlash(url, url);
  } finally {
    setBusy(false);
  }
}

function switchToFileMode() {
  document.querySelector("input[name=otaMode][value=file]").click();
}

function switchMode(mode) {
  docElem.otaFileSection.style.display = mode === "file" ? "" : "none";
  docElem.otaUrlSection.style.display = mode === "url" ? "" : "none";
  setStatus(undefined);
}

document.querySelectorAll("input[name=otaMode]").forEach(radio => {
  radio.addEventListener("change", () => switchMode(radio.value));
});

function isFileLikeDrag(types) {
  return types.includes("Files") || types.includes("codefiles");
}

let dragDepth = 0;
document.addEventListener("dragenter", e => {
  if (!isFileLikeDrag(e.dataTransfer.types)) {
    return;
  }
  e.preventDefault();
  if (++dragDepth === 1) {
    switchToFileMode();
    docElem.otaFileRow.classList.add("drag-over");
  }
});
document.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) {
    docElem.otaFileRow.classList.remove("drag-over");
  }
});
document.addEventListener("dragover", e => {
  if (isFileLikeDrag(e.dataTransfer.types)) {
    e.preventDefault();
  }
});
function requireBin(name) {
  if (name.endsWith(".bin")) {
    return true;
  }
  alert("Select a .bin file.");
  return false;
}

document.addEventListener("drop", e => {
  if (!isFileLikeDrag(e.dataTransfer.types)) {
    return;
  }
  e.preventDefault();
  dragDepth = 0;
  docElem.otaFileRow.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) {
    if (!requireBin(file.name)) {
      return;
    }
    setSelectedFile(file);
    const dt = new DataTransfer();
    dt.items.add(file);
    docElem.otaFile.files = dt.files;
    return;
  }
  const path = e.dataTransfer.getData("text/plain").trim();
  if (path && !requireBin(path)) {
    return;
  }
  setStatus(`Drag not supported from this source — use the file picker${path ? ":" : "."}`, path);
});

updateButtonStates();
loadCurrentVersion();
docElem.otaBtn.addEventListener("click", doUploadFile);
docElem.otaFetchBtn.addEventListener("click", doFetchAndUpload);
docElem.otaPath.addEventListener("click", () => {
  const sel = window.getSelection();
  if (sel?.isCollapsed) {
    sel.selectAllChildren(docElem.otaPath);
  }
});
