// hub.mjs — Cameras Hub page.
//
// Storage format: { version: 1, cameras: [{url, type, name, authId}], auths: [{id, name, username, password}] }
//
// The host (current origin) is detected as a KikkerX camera when isStandalone=false in the hub status.
// If confirmed, it appears as a self-camera card (no remove button, URL not editable).
// Cross-origin thumbnails are fetched via fetch() with an explicit Authorization header.

import { getPageOptions, patchPageOptions } from "/page_options.mjs";
import { docElem } from "/util.mjs";

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
}

const STORAGE_KEY = "hub.store";
const STORE_VERSION = 1;
const DEFAULT_INTERVAL = 30;

// Hub status received from /api/hub/status, with defaults applied.
let g_hubStatus = { isStandalone: true, store: { read: false, write: false } };

// Cached server credentials (read = GET /api/hub/store, write = PUT).
// Write falls back to read if not separately prompted.
const g_creds = { read: null, write: null };

// Controls whether editing controls (add/edit/delete/drag) are shown.
// Session-only; always starts false.
let g_allowChanging = false;

// Active drag state: source index and grab-point X (set on dragstart, cleared on dragend).
let g_drag = null; // { index, grabX }
// Active drop target: card element and insertion side (set on dragover, cleared on drop/dragend).
let g_drop = null; // { card, before }

function isSameOrigin(cam) {
  return cam.url === window.location.origin;
}

function isSelf(cam) {
  return !g_hubStatus.isStandalone && isSameOrigin(cam);
}

function authLabel(auth, index) {
  return auth.name || auth.username || `Auth ${index + 1}`;
}

function storeLabel(store) {
  const c = store?.cameras?.length ?? 0;
  const a = store?.auths?.length ?? 0;
  return `${c} camera${c === 1 ? "" : "s"}, ${a} auth${a === 1 ? "" : "s"}`;
}

// In-memory session credentials, not persisted across reloads.
// Map<cameraUrl, {username, password}>
const sessionCreds = new Map();

// Set at init time to open the edit dialog for a camera by index.
let openEditDialog = null;

// ---- Storage ----------------------------------------------------------------

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { version: STORE_VERSION, cameras: [], auths: [] };
    }
    return {
      version: raw.version ?? STORE_VERSION,
      cameras: raw.cameras ?? [],
      auths: raw.auths ?? [],
    };
  } catch {
    return { version: STORE_VERSION, cameras: [], auths: [] };
  }
}

function saveStore(store) {
  const data = { version: STORE_VERSION, ...store };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function saveCameras(cameras) {
  const store = loadStore();
  store.cameras = cameras;
  saveStore(store);
}

function loadInterval() {
  const v = getPageOptions().hubInterval;
  return typeof v === "number" ? v : DEFAULT_INTERVAL;
}

// ---- Credentials ------------------------------------------------------------

// Returns {username, password} for a camera, checking session first then the linked auth.
// Returns undefined if no credentials are found.
function getCredentials(cam) {
  if (sessionCreds.has(cam.url)) {
    return sessionCreds.get(cam.url);
  }
  if (cam.authId) {
    const auth = loadStore().auths.find(a => a.id === cam.authId);
    if (auth) {
      return { username: auth.username, password: auth.password };
    }
  }
}

// Returns an Authorization header value for the given credentials object, or null.
function basicAuthHeader(creds) {
  return creds ? `Basic ${btoa(`${creds.username}:${creds.password}`)}` : null;
}

// Normalises a raw /api/hub/status response into a consistent shape with defaults.
function parseStatus(raw) {
  return {
    isStandalone: raw?.isStandalone !== false,
    store: {
      read: raw?.store?.read === true,
      write: raw?.store?.write === true,
    },
  };
}

// Shows the credentials dialog, retrying the given URL+opts on submit until it succeeds (non-401).
// credType: "read" | "write" — sets the dialog title and which cached creds to update.
// Returns the successful Response. Throws Error("cancelled") if the user cancels.
async function credsPromptAndRetry(url, opts, credType) {
  if (credType !== "read" && credType !== "write") {
    throw new Error(`Invalid credType: ${credType}`);
  }
  const titleText = credType === "read" ? "Read credentials" : "Write credentials";
  const usernameKey = `hub.auth.${credType}.user`;

  docElem.credsTitle.textContent = titleText;
  docElem.credsUsername.value = localStorage.getItem(usernameKey) || "";
  docElem.credsPassword.value = "";
  docElem.credsError.style.display = "none";
  docElem.credsSubmitBtn.disabled = false;
  docElem.credsDialog.showModal();
  (docElem.credsUsername.value ? docElem.credsPassword : docElem.credsUsername).focus();

  return new Promise((resolve, reject) => {
    let active = true;

    function cleanup() {
      active = false;
      docElem.credsForm.removeEventListener("submit", onSubmit);
      docElem.credsCancelBtn.removeEventListener("click", onCancel);
    }

    async function onSubmit(e) {
      e.preventDefault();
      if (!active) {
        return;
      }
      const username = docElem.credsUsername.value.trim();
      const password = docElem.credsPassword.value;
      docElem.credsSubmitBtn.disabled = true;
      docElem.credsError.style.display = "none";
      const newCreds = { username, password };
      const authVal = basicAuthHeader(newCreds);
      const headers = { ...opts?.headers, Authorization: authVal };
      try {
        const resp = await fetch(url, { ...opts, headers });
        if (resp.status === 401) {
          docElem.credsError.textContent = "Wrong credentials.";
          docElem.credsError.style.display = "block";
          docElem.credsSubmitBtn.disabled = false;
          return;
        }
        g_creds[credType] = newCreds;
        localStorage.setItem(usernameKey, username);
        docElem.credsDialog.close();
        cleanup();
        resolve(resp);
      } catch {
        docElem.credsError.textContent = "Network error.";
        docElem.credsError.style.display = "block";
        docElem.credsSubmitBtn.disabled = false;
      }
    }

    function onCancel() {
      if (!active) {
        return;
      }
      docElem.credsDialog.close();
      cleanup();
      reject(new Error("cancelled"));
    }

    docElem.credsForm.addEventListener("submit", onSubmit);
    docElem.credsCancelBtn.addEventListener("click", onCancel);
  });
}

// Fetches url with cached credentials for the given credType ("read" | "write").
// On 401, prompts for credentials and retries once (via credsPromptAndRetry).
// Returns the Response on success, or null on network error, non-401 HTTP error, or user cancel.
async function authenticatedFetch(url, opts = {}, credType = "read") {
  const creds = g_creds[credType] ?? g_creds.read;
  const headers = { ...opts.headers };
  const authVal = basicAuthHeader(creds);
  if (authVal) {
    headers.Authorization = authVal;
  }
  let resp;
  try {
    resp = await fetch(url, { ...opts, headers: Object.keys(headers).length ? headers : undefined });
  } catch (e) {
    console.warn(`[hub] ${url} fetch failed:`, e.message);
    return null;
  }
  if (resp.ok) {
    return resp;
  }
  if (resp.status !== 401) {
    console.warn(`[hub] ${url} returned`, resp.status);
    return null;
  }
  try {
    return await credsPromptAndRetry(url, opts, credType);
  } catch {
    return null; // cancelled
  }
}

// ---- Hub init ---------------------------------------------------------------

// Fetches /api/hub/store and resolves SELF placeholder URLs.
// Returns the parsed store, or null on failure or user cancel.
async function fetchServerStore(credType = "read") {
  const resp = await authenticatedFetch("/api/hub/store", {}, credType);
  if (!resp) {
    return null;
  }
  const store = await resp.json();
  for (const cam of store.cameras ?? []) {
    if (cam.url === "SELF") {
      cam.url = window.location.origin;
    }
  }
  return store;
}

// Merges the server store into localStorage.
// replace=true: server config replaces local state.
// replace=false: server items not already present are appended.
function applyHubImport(serverStore, replace) {
  if (replace) {
    saveStore(serverStore);
    return;
  }
  const local = loadStore();
  const existingAuthIds = new Set(local.auths.map(a => a.id));
  const newAuths = (serverStore.auths ?? []).filter(a => !existingAuthIds.has(a.id));
  const isSameCamera = (a, b) => a.url === b.url && a.type === b.type;
  const incoming = serverStore.cameras ?? [];
  const consumedIndices = new Set();
  const mergedCameras = local.cameras.map(ex => {
    const matchIdx = incoming.findIndex((inc, i) => !consumedIndices.has(i) && isSameCamera(ex, inc));
    if (matchIdx < 0) {
      return ex;
    }
    const match = incoming[matchIdx];
    const authConflict = ex.authId && match.authId && ex.authId !== match.authId;
    const paramsConflict = ex.captureParams && match.captureParams && ex.captureParams !== match.captureParams;
    if (authConflict || paramsConflict) {
      return ex;
    }
    consumedIndices.add(matchIdx);
    const result = { ...ex };
    if (match.authId && !ex.authId) {
      result.authId = match.authId;
    }
    if (match.captureParams && !ex.captureParams) {
      result.captureParams = match.captureParams;
    }
    const localName = ex.name || "";
    const incomingName = match.name || "";
    if (incomingName && localName !== incomingName) {
      const parts = localName ? localName.split(" / ") : [];
      if (!parts.includes(incomingName)) {
        result.name = localName ? `${localName} / ${incomingName}` : incomingName;
      }
    }
    return result;
  });
  const newCameras = incoming.filter((_, i) => !consumedIndices.has(i));
  saveStore({
    cameras: [...mergedCameras, ...newCameras],
    auths: [...local.auths, ...newAuths],
  });
}

// ---- Thumbnail URL ----------------------------------------------------------

function thumbUrl(cam) {
  if (cam.type === "kikker-x") {
    const params = cam.captureParams ? `${cam.captureParams}&res=VGA` : "res=VGA";
    return `${cam.url}/api/cam/capture.jpg?${params}&_t=${Date.now()}`;
  }
  const sep = cam.url.includes("?") ? "&" : "?";
  return `${cam.url}${sep}_t=${Date.now()}`;
}

// ---- Thumbnail fetch --------------------------------------------------------

// Reads an MJPEG stream until the first complete JPEG frame is found, then
// cancels the stream. Returns a Uint8Array of JPEG bytes, or null on failure.
// Detects frame boundaries by scanning for JPEG SOI (0xFF 0xD8) and EOI (0xFF 0xD9) markers.
// reader.cancel() in the finally block closes the underlying connection cleanly
// regardless of how the function exits (frame found, stream ended, or outer abort signal).
async function extractFirstJpegFrame(resp) {
  const reader = resp.body.getReader();
  try {
    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      totalLen += value.length;
      const buf = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      // Find SOI marker (start of JPEG)
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] !== 0xff || buf[i + 1] !== 0xd8) {
          continue;
        }
        // Find EOI marker (end of JPEG) after SOI
        for (let j = i + 2; j < buf.length - 1; j++) {
          if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
            return buf.slice(i, j + 2);
          }
        }
        break; // SOI found but EOI not yet; wait for more data
      }
    }
    return null;
  } finally {
    reader.cancel();
  }
}

// Camera URLs known to block fetch due to missing CORS headers.
// Skips the fetch attempt on subsequent refreshes for these cameras.
// Maps camera base URL → "img" (image displayable via <img>) or "noimg" (auth required, not displayable).
const corsCameras = new Map();

// Returns one of:
//   {status: "ok", blobUrl}      — success
//   {status: "cors", imgUrl}     — no CORS headers; image displayable via <img>
//   {status: "auth"}             — 401/403
//   {status: "not-found"}        — 404
//   {status: "timeout"}          — request aborted after 15 s
//   {status: "http-error", httpStatus: N} — other non-ok HTTP response
//   {status: "error"}            — network error
async function fetchThumb(cam) {
  const url = thumbUrl(cam);
  if (corsCameras.has(cam.url)) {
    return { status: "cors", imgUrl: corsCameras.get(cam.url) === "img" ? url : null };
  }
  const authVal = isSameOrigin(cam) ? null : basicAuthHeader(getCredentials(cam));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const fetchOpts = { signal: controller.signal };
    if (authVal) {
      fetchOpts.headers = { Authorization: authVal };
    }
    const resp = await fetch(url, fetchOpts);
    if (resp.status === 401 || resp.status === 403) {
      clearTimeout(timeoutId);
      return { status: "auth", detail: `HTTP ${resp.status} ${resp.statusText}` };
    }
    if (resp.status === 404) {
      clearTimeout(timeoutId);
      return { status: "not-found", detail: `HTTP 404 ${resp.statusText}` };
    }
    if (!resp.ok) {
      clearTimeout(timeoutId);
      let detail = `HTTP ${resp.status} ${resp.statusText}`;
      try {
        const ct = resp.headers.get("Content-Type") || "";
        if (!ct || ct.startsWith("text/")) {
          const body = (await resp.text()).trim();
          if (body && !body.includes("\n") && body.length <= 200) {
            detail += ` — ${body}`;
          }
        }
      } catch {
        // ignore body read errors
      }
      return { status: "http-error", httpStatus: resp.status, detail };
    }
    let blob;
    const ct = resp.headers.get("Content-Type") || "";
    if (ct.includes("multipart")) {
      const frameBytes = await extractFirstJpegFrame(resp);
      clearTimeout(timeoutId);
      if (!frameBytes) {
        return { status: "error", detail: "No JPEG frame in multipart stream" };
      }
      blob = new Blob([frameBytes], { type: "image/jpeg" });
    } else {
      blob = await resp.blob();
      clearTimeout(timeoutId);
    }
    return { status: "ok", blobUrl: URL.createObjectURL(blob) };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      return { status: "timeout", detail: "Request timed out after 15 s" };
    }
    // TypeError means CORS block or network failure. Probe with <img> to distinguish:
    // <img> ignores CORS headers so it loads if the server is reachable, fails if it's down.
    const canDisplay = await new Promise(resolve => {
      const testImg = new Image();
      testImg.onload = () => resolve(true);
      testImg.onerror = () => resolve(false);
      testImg.src = url;
    });
    if (canDisplay) {
      // Server is up — CORS is blocking the fetch. If credentials were sent, auth headers
      // can't be carried via <img> either, so the thumbnail won't be displayable.
      corsCameras.set(cam.url, authVal ? "noimg" : "img");
      return { status: "cors", imgUrl: authVal ? null : url };
    }
    return { status: "error", detail: e.message || "Network error" };
  }
}

// ---- Auth section -----------------------------------------------------------

// Builds the inline auth prompt shown inside a card on a 401/403 response.
// onRetry({username, password}) is called after the user supplies credentials.
// Session creds and sibling card refresh are handled by the caller (makeCard).
function makeAuthSection(cam, onRetry) {
  const section = document.createElement("div");
  section.className = "cam-auth-section";

  const msg = document.createElement("div");
  msg.className = "cam-auth-msg";
  msg.textContent = "⚠ Auth required";
  const nameSpan = cam.authId ? document.createElement("span") : null;
  if (nameSpan) {
    nameSpan.style.cssText = "color: #c88; margin-left: 4px";
    msg.appendChild(nameSpan);
  }

  function updateLabel() {
    if (!nameSpan) {
      return;
    }
    const st = loadStore();
    const authIdx = st.auths.findIndex(a => a.id === cam.authId);
    nameSpan.textContent = authIdx >= 0 ? `— ${authLabel(st.auths[authIdx], authIdx)}` : "";
  }
  updateLabel();

  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.className = "cam-auth-input";
  userInput.placeholder = "Username";
  userInput.autocomplete = "username";
  userInput.required = true;

  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.className = "cam-auth-input";
  passInput.placeholder = "Password";
  passInput.autocomplete = "current-password";

  // Pre-fill stored username (but not password).
  const stored = getCredentials(cam);
  userInput.value = stored?.username || "";

  const authForm = document.createElement("form");

  const actions = document.createElement("div");
  actions.className = "cam-auth-actions";

  // Session: use for this page load only.
  const sessionBtn = document.createElement("button");
  sessionBtn.type = "submit";
  sessionBtn.title = "Use these credentials for this session only, without saving them";
  sessionBtn.textContent = "Use";

  authForm.addEventListener("submit", e => {
    e.preventDefault();
    onRetry({ username: userInput.value, password: passInput.value });
  });

  // Save: persist to the linked auth entry (or create a new one).
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.title = "Save these credentials to the camera list";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    if (!authForm.checkValidity()) {
      authForm.reportValidity();
      return;
    }
    const creds = { username: userInput.value, password: passInput.value };

    const st = loadStore();
    const camIdx = st.cameras.findIndex(c => c.url === cam.url);
    if (camIdx >= 0) {
      if (cam.authId) {
        const authIdx = st.auths.findIndex(a => a.id === cam.authId);
        if (authIdx >= 0) {
          st.auths[authIdx].username = creds.username;
          st.auths[authIdx].password = creds.password;
        }
      } else {
        const newAuth = {
          id: randomId(),
          name: "",
          username: creds.username,
          password: creds.password,
        };
        st.auths.push(newAuth);
        st.cameras[camIdx].authId = newAuth.id;
        cam.authId = newAuth.id;
      }
      saveStore(st);
    }
    onRetry(creds);
  });

  actions.appendChild(sessionBtn);
  if (g_allowChanging) {
    actions.appendChild(saveBtn);
  }

  authForm.appendChild(userInput);
  authForm.appendChild(passInput);
  authForm.appendChild(actions);

  section.appendChild(msg);
  section.appendChild(authForm);
  section.updateLabel = updateLabel;

  return section;
}

// ---- Card rendering ---------------------------------------------------------

// Spinner SVG: 270° arc with a gradient fading from transparent (trailing edge, 12-o'clock)
// to opaque (leading edge, 9-o'clock). Gradient defined once in hub.html as #hubSg.
const SPINNER_SVG = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="14" cy="14" r="11" stroke="#2a2a2a" stroke-width="2.5"/>
  <circle cx="14" cy="14" r="11" stroke="url(#hubSg)" stroke-width="2.5"
    stroke-dasharray="51.8 17.3" stroke-linecap="round" transform="rotate(-90 14 14)"/>
</svg>`;

// selfCam=true: this is the host device's own camera — no remove button, no auth prompt.
function makeCard(cam, index, selfCam, isDuplicate = false) {
  const card = document.createElement("div");
  card.className = "cam-card";
  if (cam.authId) {
    card.dataset.authId = cam.authId;
  }

  let lastStatusFetch = 0;
  let statusBtn = null;

  // Thumbnail area
  const thumbWrap = document.createElement("div");
  thumbWrap.className = "cam-thumb-wrap";

  const img = document.createElement("img");
  img.className = "cam-thumb";
  img.alt = cam.name || cam.url;
  img.hidden = true;

  const errDiv = document.createElement("div");
  errDiv.className = "cam-error";
  errDiv.hidden = true;

  const spinner = document.createElement("div");
  spinner.className = "cam-spinner";
  spinner.hidden = true;
  spinner.innerHTML = SPINNER_SVG;

  thumbWrap.appendChild(img);
  thumbWrap.appendChild(errDiv);
  thumbWrap.appendChild(spinner);

  // Info row
  const info = document.createElement("div");
  info.className = "cam-info";

  const nameRow = document.createElement("div");
  nameRow.style.cssText = "display:flex;align-items:center;gap:4px";

  const nameEl = document.createElement("span");
  nameEl.className = "cam-name";
  nameEl.textContent = cam.name || (selfCam ? "This camera" : cam.url);
  nameEl.title = cam.url;

  const perCamRefreshBtn = document.createElement("button");
  perCamRefreshBtn.type = "button";
  perCamRefreshBtn.className = "icon-btn";
  perCamRefreshBtn.title = "Refresh";
  perCamRefreshBtn.textContent = "↻";
  perCamRefreshBtn.style.flexShrink = "0";
  perCamRefreshBtn.addEventListener("click", () => {
    loadThumb(true);
  });

  if (g_allowChanging) {
    const handle = document.createElement("span");
    handle.className = "cam-drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    nameRow.appendChild(handle);
  }
  nameRow.appendChild(nameEl);
  nameRow.appendChild(perCamRefreshBtn);
  info.appendChild(nameRow);

  if (isDuplicate) {
    const dupEl = document.createElement("span");
    dupEl.className = "cam-dup-warning";
    dupEl.textContent = "⚠ Duplicate URL";
    info.appendChild(dupEl);
  }

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:0;margin-left:auto";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn";
  editBtn.title = g_allowChanging ? "Edit" : "View details";
  editBtn.textContent = g_allowChanging ? "✎" : "≡";
  editBtn.addEventListener("click", () => {
    openEditDialog?.(cam, index, selfCam);
  });
  btnRow.appendChild(editBtn);

  if (g_allowChanging && !selfCam) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon-btn";
    removeBtn.title = "Remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      const cameras = loadStore().cameras;
      const label = cameras[index]?.name || cameras[index]?.url;
      if (!confirm(`Remove ${label}?`)) {
        return;
      }
      cameras.splice(index, 1);
      saveCameras(cameras);
      renderGrid();
    });
    btnRow.appendChild(removeBtn);
  }

  const links = document.createElement("div");
  links.className = "cam-links";

  if (cam.type === "kikker-x") {
    for (const [label, path] of [
      ["Home", "/"],
      ["Photo", "/photo"],
      ["Video", "/video"],
    ]) {
      const a = document.createElement("a");
      a.href = cam.url + path;
      a.textContent = label;
      a.target = "_blank";
      a.draggable = false;
      links.appendChild(a);
    }
  } else {
    const a = document.createElement("a");
    a.href = cam.url;
    a.textContent = "Open";
    a.target = "_blank";
    a.draggable = false;
    links.appendChild(a);
  }

  if (cam.type === "kikker-x") {
    statusBtn = document.createElement("span");
    statusBtn.className = "cam-status-btn";
    statusBtn.hidden = true;
    links.appendChild(statusBtn);
  }

  const corsBtn = document.createElement("span");
  corsBtn.className = "cam-status-btn cam-cors-btn";
  corsBtn.hidden = true;
  corsBtn.title =
    "CORS is disabled on this camera — auth headers and status info unavailable.\nIf auth is required on this camera, thumbnails cannot be fetched.";
  links.appendChild(corsBtn);

  links.appendChild(btnRow);
  info.appendChild(links);

  // No auth section for the self camera — it shares the hub's own credentials.
  // onRetry receives the credentials and handles session storage + sibling refresh.
  const authSection = selfCam
    ? null
    : makeAuthSection(cam, creds => {
        const cameras = loadStore().cameras;
        for (const c of cameras) {
          if (cam.authId ? c.authId === cam.authId : c.url === cam.url) {
            sessionCreds.set(c.url, creds);
          }
        }
        errDiv.hidden = true;
        loadThumb();
        if (cam.authId) {
          // Also refresh other cards sharing this auth.
          document.querySelectorAll(`[data-auth-id="${cam.authId}"]`).forEach(el => {
            if (el !== card && el._refresh) {
              el._refresh();
            }
          });
        }
      });
  if (authSection) {
    authSection.hidden = true;
  }

  card.appendChild(thumbWrap);
  card.appendChild(info);
  if (authSection) {
    card.appendChild(authSection);
  }

  if (g_allowChanging) {
    card.dataset.camIndex = String(index);
    card.draggable = true;

    let dragFromHandle = false;
    card.addEventListener("mousedown", e => {
      dragFromHandle = !!e.target.closest(".cam-drag-handle");
    });
    card.addEventListener("dragstart", e => {
      if (!dragFromHandle) {
        e.preventDefault();
        return;
      }
      g_drag = { index, grabX: e.offsetX };
      e.dataTransfer.effectAllowed = "move";
      // Chrome renders <input> elements at reduced opacity in drag images.
      // Use a clone with the auth section removed as the drag image instead.
      const clone = card.cloneNode(true);
      clone.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${card.offsetWidth}px;pointer-events:none`;
      const cloneAuth = clone.querySelector(".cam-auth-section");
      if (cloneAuth) {
        cloneAuth.hidden = true;
      }
      document.body.appendChild(clone);
      e.dataTransfer.setDragImage(clone, e.offsetX, e.offsetY);
      setTimeout(() => {
        document.body.removeChild(clone);
        card.classList.add("dragging");
      }, 0);
    });

    card.addEventListener("dragover", e => {
      if (!g_drag) {
        return;
      }
      if (index === g_drag.index) {
        if (g_drop) {
          g_drop.card.classList.remove("drop-before", "drop-after");
          g_drop = null;
        }
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const threshold = g_drag.grabX + (index === 0 ? 20 : 0);
      const before = e.clientX < card.getBoundingClientRect().left + threshold;
      const isNoop = (before && index === g_drag.index + 1) || (!before && index === g_drag.index - 1);
      if (isNoop) {
        if (g_drop) {
          g_drop.card.classList.remove("drop-before", "drop-after");
          g_drop = null;
        }
        return;
      }
      if (g_drop && g_drop.card !== card) {
        g_drop.card.classList.remove("drop-before", "drop-after");
      }
      g_drop = { card, before };
      card.classList.toggle("drop-before", before);
      card.classList.toggle("drop-after", !before);
    });

    card.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!g_drop || !g_drag) {
        return;
      }
      const before = card.classList.contains("drop-before");
      card.classList.remove("drop-before", "drop-after");
      g_drop = null;
      const toIdx = Number(card.dataset.camIndex);
      const fromIdx = g_drag.index;
      if (fromIdx === toIdx) {
        return;
      }
      const cameras = loadStore().cameras;
      const [moved] = cameras.splice(fromIdx, 1);
      let insertAt = before ? toIdx : toIdx + 1;
      if (fromIdx < toIdx) {
        insertAt--;
      }
      cameras.splice(insertAt, 0, moved);
      saveCameras(cameras);
      renderGrid();
    });

    card.addEventListener("dragend", () => {
      g_drag = null;
      g_drop = null;
      card.classList.remove("dragging");
      document.querySelectorAll(".cam-card").forEach(c => {
        c.classList.remove("drop-before", "drop-after");
      });
    });
  }

  async function loadThumb(forceStatus = false) {
    if (authSection) {
      authSection.updateLabel();
    }
    spinner.hidden = false;
    errDiv.hidden = true;
    errDiv.title = "";
    const result = await fetchThumb(cam);
    spinner.hidden = true;
    if (img.src?.startsWith("blob:")) {
      URL.revokeObjectURL(img.src);
    }
    if (result.status === "ok") {
      img.src = result.blobUrl;
      img.hidden = false;
      errDiv.hidden = true;
      if (authSection) {
        authSection.hidden = true;
      }
      loadStatus(forceStatus);
    } else if (result.status === "cors") {
      if (result.imgUrl !== null) {
        img.src = result.imgUrl;
        img.hidden = false;
        errDiv.hidden = true;
      } else {
        img.hidden = true;
        errDiv.textContent = "⚠ Auth required";
        errDiv.hidden = false;
      }
      corsBtn.hidden = false;
      if (authSection) {
        authSection.hidden = true;
      }
      loadStatus(forceStatus);
    } else {
      img.hidden = true;
      if (result.status === "auth") {
        errDiv.textContent = "⚠ Auth required";
      } else if (result.status === "timeout") {
        errDiv.textContent = "⚠ Timeout";
      } else if (result.status === "not-found") {
        errDiv.textContent = "⚠ Not found";
      } else if (result.status === "http-error") {
        errDiv.textContent = `⚠ Error ${result.httpStatus}`;
      } else {
        errDiv.textContent = "⚠ Unreachable";
      }
      errDiv.title = result.detail ?? "";
      errDiv.hidden = false;
      if (authSection) {
        authSection.hidden = result.status !== "auth";
      }
      if (statusBtn && !statusBtn.hidden) {
        statusBtn.classList.add("stale");
      }
      // kikker-x's authDeny adds CORS headers to 401 unconditionally, so a readable
      // 401 doesn't confirm CORS is enabled. Probe with a credentialed request on an
      // auth-exempt path: if the preflight fails, CORS is disabled.
      if (result.status === "auth" && cam.type === "kikker-x") {
        (async () => {
          try {
            await fetch(`${cam.url}/manifest.json`, {
              headers: { Authorization: "Basic Zg==" },
              signal: AbortSignal.timeout(5000),
            });
            // Preflight passed → CORS enabled; auth prompt stays.
          } catch (e) {
            if (e.name !== "AbortError") {
              // Preflight failed → CORS disabled.
              corsCameras.set(cam.url, "noimg");
              corsBtn.hidden = false;
              if (authSection) {
                authSection.hidden = true;
              }
            }
          }
        })();
      }
    }
  }

  async function loadStatus(force = false) {
    if (!statusBtn) {
      return;
    }
    if (!force && Date.now() - lastStatusFetch < 60_000) {
      return;
    }
    try {
      const authVal = isSameOrigin(cam) ? null : basicAuthHeader(getCredentials(cam));
      const fetchOpts = { signal: AbortSignal.timeout(10000) };
      if (authVal) {
        fetchOpts.headers = { Authorization: authVal };
      }
      const resp = await fetch(`${cam.url}/api/status`, fetchOpts);
      if (!resp.ok) {
        return;
      }
      const data = await resp.json();
      lastStatusFetch = Date.now();
      const lines = [`KikkerX v${data.version}`];
      if (data.features?.board) {
        lines.push(`Board: ${data.features.board}`);
      }
      if (data.wifi) {
        const rssi = data.wifi.rssi !== undefined ? ` (${data.wifi.rssi}dB)` : "";
        lines.push(`WiFi: ${data.wifi.ssid}${rssi}`);
      }
      if (data.features?.battery && data.battery) {
        lines.push(`Battery: ${data.battery.voltage}mV (${data.battery.level}%)`);
      }
      statusBtn.title = lines.join("\n");
      statusBtn.hidden = false;
      statusBtn.classList.remove("stale");
    } catch (e) {
      console.debug(`[hub] ${cam.url}/api/status fetch failed:`, e.message);
    }
  }

  card._refresh = () => {
    loadThumb(true);
  };
  loadThumb();

  return card;
}

function renderGrid() {
  const cameras = loadStore().cameras;

  const urlCount = new Map();
  for (const cam of cameras) {
    urlCount.set(cam.url, (urlCount.get(cam.url) || 0) + 1);
  }

  const urlOrder = [];
  const groups = new Map();
  for (const [i, cam] of cameras.entries()) {
    if (!groups.has(cam.url)) {
      groups.set(cam.url, []);
      urlOrder.push(cam.url);
    }
    groups.get(cam.url).push({ cam, index: i });
  }

  docElem.camGrid.innerHTML = "";

  for (const url of urlOrder) {
    for (const { cam, index } of groups.get(url)) {
      docElem.camGrid.appendChild(makeCard(cam, index, isSelf(cam), urlCount.get(url) > 1));
    }
  }

  if (cameras.length === 0) {
    const msg = document.createElement("p");
    msg.className = "empty-msg";
    msg.textContent = "No cameras added yet.";
    docElem.camGrid.appendChild(msg);
  }
}

// ---- Auto-refresh -----------------------------------------------------------

let refreshTimerId = null;

function applyInterval(seconds) {
  clearInterval(refreshTimerId);
  refreshTimerId = seconds > 0 ? setInterval(refreshThumbs, seconds * 1000) : null;
}

function refreshThumbs() {
  document.querySelectorAll(".cam-card").forEach(card => {
    if (card._refresh) {
      card._refresh();
    }
  });
}

// ---- Toast ------------------------------------------------------------------

let toastTimer = null;

function showToast(message) {
  docElem.toast.textContent = message;
  docElem.toast.classList.remove("fade");
  if (!docElem.toast.matches(":popover-open")) {
    docElem.toast.showPopover();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    docElem.toast.classList.add("fade");
    toastTimer = setTimeout(() => {
      docElem.toast.hidePopover();
    }, 400);
  }, 4000);
}

// ---- Export / Import --------------------------------------------------------

function buildExportJson(cameras, auths) {
  function passwordMask(i) {
    return `<<<***PASS${i}***>>>`;
  }
  const masked = {
    version: 1,
    cameras,
    auths: auths.map((a, i) => ({ ...a, password: passwordMask(i) })),
  };
  let json = JSON.stringify(masked, null, 2);
  for (const [i, a] of auths.entries()) {
    const escaped = Array.from(a.password || "")
      .map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    json = json.replace(passwordMask(i), `"${escaped}"`);
  }
  return json;
}

// Only accepts the current format: {version, cameras, auths}.
function parseImportData(text) {
  const data = JSON.parse(text);
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.cameras)) {
    return { cameras: data.cameras, auths: data.auths ?? [] };
  }
  throw new Error('Unrecognized format — expected a "cameras" array');
}

// ---- Entry ------------------------------------------------------------------

docElem.intervalSel.value = String(loadInterval());
applyInterval(loadInterval());

{
  let statusData = null;
  try {
    const statusResp = await fetch("/api/hub/status");
    if (statusResp.ok) {
      statusData = await statusResp.json();
    } else {
      console.warn("[hub] /api/hub/status returned", statusResp.status);
    }
  } catch (e) {
    console.warn("[hub] /api/hub/status fetch failed:", e.message);
    showToast("Hub server not reachable");
  }

  g_hubStatus = parseStatus(statusData);

  if (g_hubStatus.store.read) {
    const hubStore = await fetchServerStore();
    if (hubStore) {
      applyHubImport(hubStore, false);
      console.info(`[hub] load: store merged from server, isStandalone=${g_hubStatus.isStandalone}`);
    } else {
      console.info("[hub] load: store not loaded, using localStorage");
    }
  } else if (!statusData) {
    console.info("[hub] load: server not reachable, using localStorage");
  } else {
    console.info("[hub] load: no server store configured, using localStorage");
  }
}

if (!g_hubStatus.isStandalone) {
  docElem.homeLink.hidden = false;
}

function applyRoleToUI() {
  docElem.addBtn.hidden = !g_allowChanging;
  docElem.loadBtn.hidden = !g_hubStatus.store.read;
  docElem.saveBtn.hidden = !g_hubStatus.store.write;
  docElem.resetDefaultsBtn.hidden = !g_hubStatus.store.read;
  docElem.allowChangingChk.checked = g_allowChanging;
}

applyRoleToUI();

// ---- Manage menu ------------------------------------------------------------

docElem.manageBtn.addEventListener("click", e => {
  e.stopPropagation();
  docElem.manageMenu.hidden = !docElem.manageMenu.hidden;
});

document.addEventListener("click", () => {
  docElem.manageMenu.hidden = true;
});

docElem.manageMenu.addEventListener("click", e => {
  e.stopPropagation();
});

docElem.loadBtn.addEventListener("click", async () => {
  docElem.manageMenu.hidden = true;
  const serverStore = await fetchServerStore();
  if (!serverStore) {
    return;
  }
  if (!confirm(`Merge stored configuration (${storeLabel(serverStore)}) into local?`)) {
    return;
  }
  applyHubImport(serverStore, false);
  renderGrid();
  showToast("Loaded from server");
});

docElem.saveBtn.addEventListener("click", async () => {
  docElem.manageMenu.hidden = true;
  const local = loadStore();
  // Fetch server store using write credentials (prompting if needed) to get current counts.
  // This also pre-caches write credentials for the subsequent PUT.
  const storeResp = await authenticatedFetch("/api/hub/store", {}, "write");
  if (!storeResp) {
    return; // cancelled or error
  }
  const serverStore = await storeResp.json().catch(() => null);

  const msg = `Overwrite the stored configuration (${storeLabel(serverStore)}) with local configuration (${storeLabel(local)})?`;
  if (!confirm(msg)) {
    return;
  }

  const body = JSON.stringify({ version: STORE_VERSION, ...local });
  // Base opts without auth — used by credsPromptAndRetry if first attempt fails.
  const putOpts = { method: "PUT", headers: { "Content-Type": "application/json" }, body };
  const firstHeaders = { "Content-Type": "application/json" };
  const authVal = basicAuthHeader(g_creds.write ?? g_creds.read);
  if (authVal) {
    firstHeaders.Authorization = authVal;
  }
  let resp;
  try {
    resp = await fetch("/api/hub/store", { ...putOpts, headers: firstHeaders });
  } catch {
    showToast("Save failed: network error");
    return;
  }
  if (resp.status === 401) {
    try {
      resp = await credsPromptAndRetry("/api/hub/store", putOpts, "write");
    } catch {
      return; // cancelled
    }
  }
  if (resp.ok) {
    showToast("Saved to server");
  } else {
    const err = await resp.json().catch(() => null);
    showToast(`Save failed: ${err?.error ?? resp.status}`);
  }
});

docElem.removeAllBtn.addEventListener("click", () => {
  docElem.manageMenu.hidden = true;
  const local = loadStore();
  if (!confirm(`Clear local configuration (${storeLabel(local)})?`)) {
    return;
  }
  saveStore({ version: STORE_VERSION, cameras: [], auths: [] });
  renderGrid();
});

docElem.resetDefaultsBtn.addEventListener("click", async () => {
  docElem.manageMenu.hidden = true;
  const serverStore = await fetchServerStore();
  if (!serverStore) {
    return;
  }
  const local = loadStore();
  const message = `Replace local configuration (${storeLabel(local)}) with stored configuration (${storeLabel(serverStore)})?`;
  if (!confirm(message)) {
    return;
  }
  applyHubImport(serverStore, true);
  renderGrid();
});

// ---- Allow changing toggle ----

docElem.allowChangingChk.addEventListener("change", e => {
  g_allowChanging = e.target.checked;
  docElem.manageMenu.hidden = true;
  applyRoleToUI();
  renderGrid();
});

renderGrid();

docElem.camGrid.addEventListener("dragover", e => {
  if (!g_drag) {
    return;
  }
  e.preventDefault();
});
docElem.camGrid.addEventListener("dragleave", e => {
  if (!g_drag || docElem.camGrid.contains(e.relatedTarget)) {
    return;
  }
  if (g_drop) {
    g_drop.card.classList.remove("drop-before", "drop-after");
    g_drop = null;
  }
});
docElem.camGrid.addEventListener("drop", e => {
  e.preventDefault();
  if (!g_drop || !g_drag) {
    return;
  }
  const { card, before } = g_drop;
  const fromIdx = g_drag.index;
  const toIdx = Number(card.dataset.camIndex);
  card.classList.remove("drop-before", "drop-after");
  g_drop = null;
  if (fromIdx === toIdx) {
    return;
  }
  const cameras = loadStore().cameras;
  const [moved] = cameras.splice(fromIdx, 1);
  let insertAt = before ? toIdx : toIdx + 1;
  if (fromIdx < toIdx) {
    insertAt--;
  }
  cameras.splice(insertAt, 0, moved);
  saveCameras(cameras);
  renderGrid();
});

// Refresh interval
docElem.intervalSel.addEventListener("change", () => {
  const v = Number(docElem.intervalSel.value);
  patchPageOptions({ hubInterval: v });
  applyInterval(v);
});

docElem.refreshNowBtn.addEventListener("click", refreshThumbs);

// ---- Add / edit camera dialog ----
const dialogTitle = docElem.addDialog.querySelector("h3");
const submitBtn = docElem.addForm.querySelector("[type='submit']");

let editIndex = -1;
let editSelfCam = false;
let editCam = null;

function updateUrlLabel() {
  const type = docElem.addForm.querySelector("input[name='type']:checked").value;
  const isKikker = type === "kikker-x";
  docElem.urlLabel.textContent = isKikker ? "Base URL:" : "Capture URL:";
  docElem.addUrl.placeholder = isKikker ? "http://timercam.local" : "http://cam/snapshot.jpg";
  docElem.captureParamsRow.hidden = !isKikker;
}

docElem.addForm.querySelectorAll("input[name='type']").forEach(r => {
  r.addEventListener("change", () => {
    updateUrlLabel();
    docElem.addUrl.focus();
  });
});

docElem.addAuth.addEventListener("change", () => {
  const isNew = docElem.addAuth.value === "__new__";
  docElem.newAuthFields.hidden = !isNew;
  docElem.addUsername.required = isNew;
});

function populateAuthDropdown(selectedAuthId) {
  docElem.addAuth.innerHTML = '<option value="">None</option>';
  const auths = loadStore().auths;
  for (const [i, auth] of auths.entries()) {
    const opt = document.createElement("option");
    opt.value = auth.id;
    opt.textContent = authLabel(auth, i);
    docElem.addAuth.appendChild(opt);
  }
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New auth…";
  docElem.addAuth.appendChild(newOpt);

  docElem.addAuth.value = selectedAuthId ?? "";
  const isNew = docElem.addAuth.value === "__new__";
  docElem.newAuthFields.hidden = !isNew;
  docElem.addUsername.required = isNew;
}

function openDialog(cam = null, index = -1, selfCam = false) {
  editIndex = index;
  editSelfCam = selfCam;
  editCam = cam;
  const viewOnly = !g_allowChanging;

  // Reset disabled state from previous open.
  docElem.addForm.querySelectorAll("input, select").forEach(el => {
    el.disabled = viewOnly;
  });

  if (cam) {
    dialogTitle.textContent = viewOnly ? "Camera details" : "Edit camera";
    submitBtn.textContent = "Save";
    submitBtn.hidden = viewOnly;
    docElem.addForm.querySelector(`input[name='type'][value='${cam.type}']`).checked = true;
    docElem.addUrl.value = cam.url;
    docElem.addName.value = cam.name || "";
    docElem.addCaptureParams.value = cam.captureParams || "";
    populateAuthDropdown(cam.authId);
  } else {
    dialogTitle.textContent = "Add camera";
    submitBtn.textContent = "Add";
    submitBtn.hidden = false;
    docElem.addForm.querySelector("input[name='type'][value='kikker-x']").checked = true;
    docElem.addUrl.value = "";
    docElem.addName.value = "";
    docElem.addCaptureParams.value = "";
    populateAuthDropdown(null);
  }

  docElem.authSelfNote.hidden = !selfCam;
  docElem.dupBtn.hidden = !cam || viewOnly;
  docElem.copyBtn.hidden = !cam;
  if (selfCam || viewOnly) {
    docElem.addForm.querySelectorAll("input[name='type']").forEach(r => {
      r.disabled = true;
    });
    docElem.addUrl.disabled = true;
  }

  docElem.cancelBtn.textContent = viewOnly ? "Close" : "Cancel";
  docElem.viewOnlyNote.hidden = !viewOnly;

  docElem.addAuthName.value = "";
  docElem.addUsername.value = "";
  docElem.addPassword.value = "";
  updateUrlLabel();
  docElem.addDialog.showModal();
  if (!viewOnly) {
    (selfCam ? docElem.addName : docElem.addUrl).focus();
  }
}

openEditDialog = (cam, index, selfCam = false) => openDialog(cam, index, selfCam);

docElem.addBtn.addEventListener("click", () => openDialog());
docElem.cancelBtn.addEventListener("click", () => docElem.addDialog.close());

docElem.dupBtn.addEventListener("click", () => {
  editIndex = -1;
  editSelfCam = false;
  dialogTitle.textContent = "Add camera";
  submitBtn.textContent = "Add";
  submitBtn.hidden = false;
  docElem.addForm.querySelectorAll("input[name='type']").forEach(r => {
    r.disabled = false;
  });
  docElem.addUrl.disabled = false;
  docElem.authSelfNote.hidden = true;
  showToast("Pre-filled — save to add as new");
  docElem.dupBtn.hidden = true;
  docElem.copyBtn.hidden = true;
});

docElem.copyBtn.addEventListener("click", () => {
  if (!editCam) {
    return;
  }
  const st = loadStore();
  const camAuths = editCam.authId ? st.auths.filter(a => a.id === editCam.authId) : [];
  navigator.clipboard.writeText(buildExportJson([editCam], camAuths)).then(() => showToast("Copied to clipboard"));
});

docElem.addForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = docElem.addName.value.trim();
  const captureParams = docElem.addCaptureParams.value.trim();

  const cameras = loadStore().cameras;

  // URL/type: read from form for normal cameras, preserved from existing entry for self-cam.
  let url, type;
  if (editSelfCam) {
    ({ url, type } = cameras[editIndex]);
  } else {
    type = docElem.addForm.querySelector("input[name='type']:checked").value;
    url = docElem.addUrl.value.trim();
    if (!url) {
      return;
    }
    if (type === "kikker-x") {
      try {
        url = new URL(url).origin;
      } catch {
        return;
      }
    } else {
      url = url.replace(/\/$/, "");
    }
  }

  // Auth resolution (shared).
  let authId = null;
  const authVal = docElem.addAuth.value;
  if (authVal === "__new__") {
    const newAuth = {
      id: randomId(),
      name: docElem.addAuthName.value.trim(),
      username: docElem.addUsername.value.trim(),
      password: docElem.addPassword.value,
    };
    const st = loadStore();
    st.auths.push(newAuth);
    saveStore(st);
    authId = newAuth.id;
  } else if (authVal) {
    authId = authVal;
  }

  const entry = { url, type, name, authId };
  if (type === "kikker-x" && captureParams) {
    entry.captureParams = captureParams;
  }
  if (editIndex >= 0) {
    if (!editSelfCam) {
      sessionCreds.delete(cameras[editIndex]?.url);
    }
    cameras[editIndex] = entry;
  } else {
    cameras.push(entry);
  }

  saveCameras(cameras);
  renderGrid();
  docElem.addDialog.close();
});

// ---- Manage Auths dialog ----

function renderAuthsList() {
  const st = loadStore();
  docElem.authsList.innerHTML = "";

  // Count cameras per auth.
  const camCount = new Map();
  for (const cam of st.cameras) {
    if (cam.authId) {
      camCount.set(cam.authId, (camCount.get(cam.authId) || 0) + 1);
    }
  }

  if (st.auths.length === 0) {
    const empty = document.createElement("p");
    empty.style.cssText = "color: #666; font-size: 13px; padding: 8px 0";
    empty.textContent = "No saved auths.";
    docElem.authsList.appendChild(empty);
    return;
  }

  for (const [i, auth] of st.auths.entries()) {
    const item = document.createElement("div");
    item.className = "auth-item";

    const infoDiv = document.createElement("div");
    infoDiv.className = "auth-item-info";

    const nameEl = document.createElement("div");
    nameEl.className = "auth-item-name";
    nameEl.textContent = authLabel(auth, i);

    const countEl = document.createElement("div");
    countEl.className = "auth-item-count";
    const n = camCount.get(auth.id) || 0;
    countEl.textContent = n === 0 ? "unused" : `${n} camera${n === 1 ? "" : "s"}`;

    infoDiv.appendChild(nameEl);
    infoDiv.appendChild(countEl);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.title = g_allowChanging ? "Edit" : "View details";
    editBtn.textContent = g_allowChanging ? "✎" : "≡";
    editBtn.addEventListener("click", () => openEditAuthDialog(auth, !g_allowChanging));

    const btnGroup = document.createElement("div");
    btnGroup.style.cssText = "display:flex";
    btnGroup.appendChild(editBtn);

    if (g_allowChanging) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "icon-btn";
      deleteBtn.title = "Delete";
      deleteBtn.textContent = "✕";
      deleteBtn.addEventListener("click", () => {
        const label = authLabel(auth, i);
        const n = camCount.get(auth.id) || 0;
        const msg =
          n > 0
            ? `Delete "${label}"? It is used by ${n} camera${n === 1 ? "" : "s"}, which will become unauthenticated.`
            : `Delete "${label}"?`;
        if (!confirm(msg)) {
          return;
        }
        const st2 = loadStore();
        st2.auths = st2.auths.filter(a => a.id !== auth.id);
        for (const cam of st2.cameras) {
          if (cam.authId === auth.id) {
            cam.authId = null;
          }
        }
        saveStore(st2);
        renderAuthsList();
        renderGrid();
      });
      btnGroup.appendChild(deleteBtn);
    }

    item.appendChild(infoDiv);
    item.appendChild(btnGroup);

    docElem.authsList.appendChild(item);
  }

  docElem.authsAddBtn.hidden = !g_allowChanging;
}

docElem.authsBtn.addEventListener("click", () => {
  renderAuthsList();
  docElem.authsDialog.showModal();
});
docElem.authsAddBtn.addEventListener("click", () => openEditAuthDialog());
docElem.authsCloseBtn.addEventListener("click", () => docElem.authsDialog.close());

// ---- Edit Auth dialog ----
const eaTitle = docElem.editAuthDialog.querySelector("h3");

let editingAuthId = null;

function openEditAuthDialog(auth = null, viewOnly = false) {
  editingAuthId = auth?.id ?? null;
  eaTitle.textContent = viewOnly ? "Auth details" : auth ? "Edit Auth" : "New Auth";
  docElem.eaName.value = auth?.name || "";
  docElem.eaUsername.value = auth?.username || "";
  docElem.eaPassword.value = auth?.password || "";
  [docElem.eaName, docElem.eaUsername, docElem.eaPassword].forEach(el => {
    el.disabled = viewOnly;
  });
  docElem.editAuthForm.querySelector("button[type='submit']").hidden = viewOnly;
  docElem.eaCancelBtn.textContent = viewOnly ? "Close" : "Cancel";
  docElem.editAuthDialog.showModal();
  if (!viewOnly) {
    docElem.eaUsername.focus();
  }
}

docElem.eaCancelBtn.addEventListener("click", () => docElem.editAuthDialog.close());

docElem.editAuthForm.addEventListener("submit", e => {
  e.preventDefault();
  const st = loadStore();
  if (editingAuthId) {
    const idx = st.auths.findIndex(a => a.id === editingAuthId);
    if (idx >= 0) {
      st.auths[idx].name = docElem.eaName.value.trim();
      st.auths[idx].username = docElem.eaUsername.value.trim();
      st.auths[idx].password = docElem.eaPassword.value;
    }
  } else {
    st.auths.push({
      id: randomId(),
      name: docElem.eaName.value.trim(),
      username: docElem.eaUsername.value.trim(),
      password: docElem.eaPassword.value,
    });
  }
  saveStore(st);
  docElem.editAuthDialog.close();
  renderAuthsList();

  // After editing an existing auth, clear stale session creds and refresh affected cards.
  if (editingAuthId) {
    for (const cam of loadStore().cameras) {
      if (cam.authId === editingAuthId) {
        sessionCreds.delete(cam.url);
      }
    }
    document.querySelectorAll(`[data-auth-id="${editingAuthId}"]`).forEach(el => {
      if (el._refresh) {
        el._refresh();
      }
    });
  }
});

// ---- Export dialog ----
function openExportDialog(cameras, auths) {
  docElem.exportText.value = buildExportJson(cameras, auths);
  docElem.exportDialog.showModal();
  docElem.exportText.select();
}

docElem.exportText.addEventListener("click", () => docElem.exportText.select());

docElem.exportBtn.addEventListener("click", () => {
  docElem.manageMenu.hidden = true;
  const store = loadStore();
  openExportDialog(store.cameras, store.auths);
});

docElem.exportSaveBtn.addEventListener("click", () => {
  const blob = new Blob([docElem.exportText.value], { type: "application/json" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = "cameras_store.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
});

docElem.exportCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(docElem.exportText.value).then(() => showToast("Copied to clipboard"));
});

docElem.exportCloseBtn.addEventListener("click", () => docElem.exportDialog.close());

// ---- Import dialog ----

function showImportError(msg) {
  docElem.importError.textContent = msg;
  docElem.importError.style.display = "block";
}

docElem.importText.addEventListener("input", () => {
  docElem.importError.style.display = "none";
});

docElem.importBtn.addEventListener("click", () => {
  docElem.manageMenu.hidden = true;
  docElem.importText.value = "";
  docElem.importError.style.display = "none";
  docElem.importReplaceChk.checked = false;
  docElem.importDialog.showModal();
  docElem.importText.focus();
});

docElem.importFileBtn.addEventListener("click", () => docElem.fileInput.click());

docElem.fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    docElem.importText.value = ev.target.result;
    docElem.importError.style.display = "none";
  };
  reader.readAsText(file);
});

docElem.importDoBtn.addEventListener("click", () => {
  const replace = docElem.importReplaceChk.checked;
  if (replace && !confirm("All existing cameras and auths will be lost. Continue?")) {
    return;
  }
  try {
    applyHubImport(parseImportData(docElem.importText.value), replace);
    renderGrid();
    docElem.importDialog.close();
  } catch {
    showImportError("Invalid JSON — check the format and try again.");
  }
});

docElem.importCancelBtn.addEventListener("click", () => docElem.importDialog.close());
