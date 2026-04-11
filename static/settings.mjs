const PRESETS_KEY = "presets";

import { getPageOptions, patchPageOptions } from "/page_options.mjs";

const DEFAULTS = {
  quality: 12,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  sharpness: 1,
  denoise: 0,
  ae_level: 0,
  wb_mode: "0",
  aec: true,
  aec_value: 490,
  agc: true,
  agc_gain: 2,
  gainceiling: 248, // hardware power-on default
  hmirror: false,
  vflip: true,
  awb_gain: false,
  aec2: false,
  bpc: true,
  wpc: true,
  raw_gma: true,
  lenc: true,
  dcw: true,
  colorbar: false,
  rotate: 0,
};

// Auto checkbox → manual control that it overrides.
// When auto is on, the dependent control is visually greyed (still interactive,
// so the user can pre-set values) and its value is omitted from params().
const AUTO_DEPS = {
  aec: "aec_value",
  agc: "agc_gain",
};

// Control → checkbox it requires to be ON to have any effect.
// Greyed visually when the required checkbox is off; still sent in params().
const REQUIRES = {
  aec2: "aec",
};

// Settings that are saved alongside camera params but never sent to the camera.
const DISPLAY_ONLY = new Set(["rotate"]);

export class Settings {
  constructor(pageType, { onSettingsChanged = null, onApplyRotation = null, onPageReady = null } = {}) {
    this._pageType = pageType;
    this._storageKey = `${pageType}.settings`;
    this._resKey = `${pageType}.res`;
    this._defaultRes = pageType === "photo" ? "UXGA" : "VGA";
    this._defaults = { ...DEFAULTS, quality: pageType === "photo" ? 4 : 12 };
    this._onSettingsChanged = onSettingsChanged;
    this._onApplyRotation = onApplyRotation;
    this._onPageReady = onPageReady;
    this._debounceTimer = null;
    document.addEventListener("DOMContentLoaded", () => this._onDOMReady());
  }

  // --- Public API ---

  params() {
    const resEl = document.getElementById("res");
    const res = resEl ? resEl.value : this._defaultRes;
    // Omit manual controls whose auto checkbox is currently on.
    const skipped = new Set();
    for (const autoId in AUTO_DEPS) {
      const autoEl = document.getElementById(autoId);
      if (autoEl?.checked) {
        skipped.add(AUTO_DEPS[autoId]);
      }
    }
    const parts = Object.keys(this._defaults)
      .filter(id => !skipped.has(id) && !DISPLAY_ONLY.has(id) && !this._isDefaultVal(id))
      .map(id => `${id}=${this._getVal(id)}`);
    return `?res=${res}${parts.length ? `&${parts.join("&")}` : ""}`;
  }

  // Rotate el (an <img> or <canvas>) to match the current rotate control value.
  // Natural dimensions: el.naturalWidth/Height for <img>, el.width/height for <canvas>.
  applyElementRotation(el) {
    const rotEl = document.getElementById("rotate");
    const deg = rotEl ? Number(rotEl.value) : 0;

    el.classList.remove("rot-90r", "rot-90l", "rot-180");
    el.style.width = "";
    el.style.height = "";
    el.style.maxWidth = "";
    el.style.maxHeight = "";
    el.style.marginLeft = "";
    el.parentElement.style.height = "";

    if (deg === 0) {
      return;
    }

    if (deg === 90 || deg === -90) {
      const natW = el.naturalWidth ?? el.width;
      const natH = el.naturalHeight ?? el.height;
      if (!natW) {
        return; // no image yet; called again after load
      }
      const isAbsolute = getComputedStyle(el).position === "absolute";
      const cw = el.parentElement.clientWidth;
      if (isAbsolute) {
        const ch = el.parentElement.clientHeight;
        const scale = Math.min(cw / natH, ch / natW, 1);
        el.style.width = `${Math.round(natW * scale)}px`;
        el.style.height = `${Math.round(natH * scale)}px`;
        el.style.maxWidth = "none";
        el.style.maxHeight = "none";
      } else {
        // Mobile: scale so rotated visual width (= rendered height) fills cw,
        // capped so visual height (= rendered width) doesn't exceed 50dvh.
        const scale = Math.min(cw / natH, (window.innerHeight * 0.5) / natW, 1);
        const wRender = Math.round(natW * scale);
        const hRender = Math.round(natH * scale); // ≈ cw
        el.style.width = `${wRender}px`;
        el.style.height = `${hRender}px`;
        el.style.maxWidth = "none";
        el.style.maxHeight = "none";
        // If hRender < cw (height cap active), center the visual horizontally.
        el.style.marginLeft = hRender < cw ? `${Math.round((cw - hRender) / 2)}px` : "";
        el.parentElement.style.height = `${wRender}px`;
      }
      el.classList.add(deg > 0 ? "rot-90r" : "rot-90l");
      return;
    }

    el.classList.add("rot-180");
  }

  // --- Settings state ---

  _syncDependents() {
    for (const autoId in AUTO_DEPS) {
      const depId = AUTO_DEPS[autoId];
      const autoEl = document.getElementById(autoId);
      const depEl = document.getElementById(depId);
      if (!autoEl || !depEl) {
        continue;
      }
      const ctrl = depEl.closest(".ctrl");
      if (ctrl) {
        ctrl.classList.toggle("ctrl-disabled", autoEl.checked);
      }
    }
    for (const depId in REQUIRES) {
      const reqId = REQUIRES[depId];
      const reqEl = document.getElementById(reqId);
      const depEl = document.getElementById(depId);
      if (!reqEl || !depEl) {
        continue;
      }
      const ctrl = depEl.closest(".ctrl");
      if (ctrl) {
        ctrl.classList.toggle("ctrl-disabled", !reqEl.checked);
      }
    }
  }

  _getVal(id) {
    const el = document.getElementById(id);
    if (!el) {
      return "";
    }
    return el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value;
  }

  _syncValue(id) {
    const el = document.getElementById(`v${id}`);
    if (el) {
      el.textContent = document.getElementById(id).value;
    }
  }

  _isDefaultVal(id) {
    const def = this._defaults[id];
    const el = document.getElementById(id);
    if (!el) {
      return false;
    }
    if (el.type === "checkbox") {
      return el.checked === def;
    }
    return String(el.value) === String(def);
  }

  _applySettings(settings) {
    for (const id in settings) {
      const el = document.getElementById(id);
      if (!el) {
        continue;
      }
      const val = settings[id];
      if (el.type === "checkbox") {
        el.checked = val === true || val === 1 || val === "1";
      } else {
        el.value = val;
        this._syncValue(id);
      }
    }
    this._syncDependents();
  }

  _persistSettings() {
    const s = {};
    for (const id in this._defaults) {
      const el = document.getElementById(id);
      if (el) {
        s[id] = el.type === "checkbox" ? el.checked : el.value;
      }
    }
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(s));
    } catch (e) {
      console.warn("persistSettings: failed to save settings:", e);
    }
    const resEl = document.getElementById("res");
    if (resEl) {
      try {
        localStorage.setItem(this._resKey, resEl.value);
      } catch (e) {
        console.warn("persistSettings: failed to save res:", e);
      }
    }
  }

  _loadSettings() {
    try {
      const s = localStorage.getItem(this._storageKey);
      if (s) {
        this._applySettings(JSON.parse(s));
      }
    } catch (e) {
      console.warn("loadSettings: failed to load settings:", e);
    }
    try {
      const savedRes = localStorage.getItem(this._resKey);
      const resEl = document.getElementById("res");
      if (savedRes && resEl) {
        resEl.value = savedRes;
      }
    } catch (e) {
      console.warn("loadSettings: failed to load res:", e);
    }
  }

  _updateUrlDisplay() {
    const el = document.getElementById("urlDisplay");
    if (!el) {
      return;
    }
    const path = this._pageType === "video" ? "/api/cam/stream.mjpeg" : "/api/cam/capture.jpg";
    el.value = window.location.origin + path + this.params();
    el.title = el.value;
  }

  _restart() {
    this._updateUrlDisplay();
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._persistSettings();
      this._onSettingsChanged?.(this.params());
    }, 50);
  }

  _resetCtrl(id) {
    const el = document.getElementById(id);
    const def = this._defaults[id];
    if (el.type === "checkbox") {
      el.checked = def;
    } else {
      el.value = def;
      this._syncValue(id);
    }
    this._syncDependents();
    this._restart();
  }

  _resetRes() {
    const resEl = document.getElementById("res");
    if (resEl) {
      resEl.value = this._defaultRes;
    }
    try {
      localStorage.removeItem(this._resKey);
    } catch (e) {
      console.warn("resetRes: failed to clear saved resolution:", e);
    }
    this._restart();
  }

  _resetAll() {
    for (const id in this._defaults) {
      const el = document.getElementById(id);
      if (!el) {
        continue;
      }
      const def = this._defaults[id];
      if (el.type === "checkbox") {
        el.checked = def;
      } else {
        el.value = def;
        this._syncValue(id);
      }
    }
    this._syncDependents();
    this._restart();
  }

  // --- Presets (resolution excluded) ---

  _getPresets() {
    try {
      return JSON.parse(localStorage.getItem(PRESETS_KEY)) || [];
    } catch (e) {
      console.warn("getPresets:", e);
      return [];
    }
  }

  _savePreset() {
    const s = {};
    for (const id in this._defaults) {
      const el = document.getElementById(id);
      if (el) {
        s[id] = el.type === "checkbox" ? el.checked : el.value;
      }
    }
    const presets = this._getPresets();
    presets.push(s);
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch (e) {
      console.warn("savePreset:", e);
    }
    this._renderPresets();
  }

  _loadPreset(i) {
    const presets = this._getPresets();
    if (i < presets.length) {
      this._applySettings(presets[i]);
      this._persistSettings();
      this._restart();
    }
  }

  _deletePreset(i) {
    const presets = this._getPresets();
    presets.splice(i, 1);
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch (e) {
      console.warn("deletePreset:", e);
    }
    this._renderPresets();
  }

  _renderPresets() {
    const container = document.getElementById("presetsList");
    if (!container) {
      return;
    }
    container.innerHTML = "";
    this._getPresets().forEach((_, i) => {
      const item = document.createElement("span");
      item.className = "preset-item";
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = i + 1;
      load.title = `Load preset ${i + 1}`;
      load.addEventListener("click", () => this._loadPreset(i));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.innerHTML = "&times;";
      del.title = "Delete";
      del.addEventListener("click", () => this._deletePreset(i));
      item.append(load, del);
      container.appendChild(item);
    });
  }

  // --- Panel open/close state ---

  _savePageOptions() {
    const sd = document.getElementById("settingsDetails");
    const ad = document.getElementById("settingsAdvDetails");
    patchPageOptions({
      settingsOpen: sd ? sd.open : false,
      advOpen: ad ? ad.open : false,
    });
  }

  _loadPageOptions() {
    const opts = getPageOptions();
    const sd = document.getElementById("settingsDetails");
    const ad = document.getElementById("settingsAdvDetails");
    if (sd) {
      sd.open = !!opts.settingsOpen;
    }
    if (ad) {
      ad.open = !!opts.advOpen;
    }
  }

  // --- Hint modal ---

  _showHint(btn) {
    document.getElementById("hintText").textContent = btn.title;
    document.getElementById("hintOverlay").style.display = "flex";
  }

  _closeHint() {
    document.getElementById("hintOverlay").style.display = "none";
  }

  // --- Settings panel HTML generation ---

  _hintBtn(hint) {
    if (!hint) {
      return "";
    }
    const h = hint.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<button type="button" class="hint-btn" title="${h}">ℹ</button>`;
  }

  _resetBtn(id) {
    const def = this._defaults[id];
    const tip = typeof def === "boolean" ? (def ? "Reset to on" : "Reset to off") : `Reset to ${def}`;
    return `<button type="button" class="icon-btn" data-reset-id="${id}" title="${tip}">↺</button>`;
  }

  _rangeCtrl(id, label, min, max, indented, hint) {
    const def = this._defaults[id] !== undefined ? this._defaults[id] : 0;
    const cls = indented ? " ctrl-indented" : "";
    return `
    <div class="ctrl${cls}">
      <div class="ctrl-header">
        <span>${label}</span>
        <span class="ctrl-actions"><span id="v${id}" class="ctrl-value">${def}</span>${this._resetBtn(id)}${this._hintBtn(hint)}</span>
      </div>
      <input type="range" id="${id}" min="${min}" max="${max}" value="${def}">
    </div>`;
  }

  _checkCtrl(id, label, hint) {
    const def = this._defaults[id];
    return `
    <div class="ctrl">
      <div class="ctrl-header">
        <span>${label}</span>
        <span class="ctrl-actions">
          <input type="checkbox" id="${id}" ${def ? "checked" : ""}>
          ${this._resetBtn(id)}${this._hintBtn(hint)}
        </span>
      </div>
    </div>`;
  }

  _selectCtrl(id, label, options, indented, hint) {
    const def = String(this._defaults[id] !== undefined ? this._defaults[id] : "");
    const defLabel = (options.find(o => o.v === def) || { l: def }).l;
    const opts = options.map(o => `<option value="${o.v}" ${o.v === def ? "selected" : ""}>${o.l}</option>`).join("");
    const cls = indented ? " ctrl-indented" : "";
    return `
    <div class="ctrl${cls}">
      <div class="ctrl-header">
        <span>${label}</span>
        <span class="ctrl-actions"><button type="button" class="icon-btn" data-reset-id="${id}" title="Reset to ${defLabel}">↺</button>${this._hintBtn(hint)}</span>
      </div>
      <select class="ctrl-select" id="${id}">${opts}</select>
    </div>`;
  }

  _buildSettingsHTML() {
    const wb = [
      { v: "0", l: "Auto" },
      { v: "1", l: "Sunny" },
      { v: "2", l: "Cloudy" },
      { v: "3", l: "Office" },
      { v: "4", l: "Home" },
    ];
    return `
    <div id="hintOverlay">
      <div id="hintModal">
        <p id="hintText"></p>
        <button type="button" class="hint-close">✕</button>
      </div>
    </div>
    <details id="settingsDetails">
      <summary>Settings</summary>
      <div class="settings-grid">
        ${this._rangeCtrl(
          "quality",
          "Quality (lower=better)",
          1,
          63,
          false,
          "JPEG compression level. Lower value = better quality and larger file size.",
        )}
        ${this._rangeCtrl(
          "brightness",
          "Brightness",
          -2,
          2,
          false,
          "Overall brightness offset applied after exposure. 0 = neutral.",
        )}
        ${this._rangeCtrl("contrast", "Contrast", -2, 2, false, "Contrast adjustment. 0 = neutral.")}
        ${this._checkCtrl(
          "aec2",
          "Anti-banding (AEC2)",
          "Synchronizes the sensor exposure time with the power line frequency (50/60 Hz), eliminating horizontal banding under artificial light. Also enables longer integration times in low-light scenes at the cost of frame rate. Only effective when Auto Exposure Control (AEC) is on.",
        )}
        ${this._selectCtrl(
          "rotate",
          "Orientation",
          [
            { v: "0", l: "Default" },
            { v: "90", l: "90° right" },
            { v: "-90", l: "90° left" },
            { v: "180", l: "180°" },
          ],
          false,
          "Rotate the displayed image. Useful when the camera is mounted sideways or upside-down. Not sent to the camera.",
        )}
      </div>
      <details id="settingsAdvDetails">
        <summary class="adv-summary">Advanced</summary>
        <div class="settings-grid">
          ${this._checkCtrl("hmirror", "H-mirror", "Mirror the image left-to-right.")}
          ${this._checkCtrl(
            "vflip",
            "V-flip",
            "Flip the image upside-down. On by default because the Timer Camera X sensor is physically mounted upside-down.",
          )}
          ${this._selectCtrl(
            "wb_mode",
            "White balance",
            wb,
            false,
            "White balance mode. Auto lets the Auto White Balance (AWB) algorithm adjust colour temperature continuously. The presets (Sunny, Cloudy, etc.) apply a fixed colour matrix instead.",
          )}
          ${this._rangeCtrl(
            "saturation",
            "Saturation",
            -2,
            2,
            false,
            "Colour saturation. 0 = neutral; negative values desaturate toward greyscale.",
          )}
          ${this._rangeCtrl(
            "ae_level",
            "AE level",
            -2,
            2,
            false,
            "Auto Exposure (AE) target offset, also known as EV compensation. Positive = brighter target, negative = darker. Only effective when Auto Exposure Control (AEC) is on.",
          )}
          ${this._checkCtrl(
            "aec",
            "Auto exposure (AEC)",
            "Auto Exposure Control (AEC): the camera automatically adjusts shutter speed to reach the target brightness. When off, exposure time is set manually below.",
          )}
          ${this._rangeCtrl(
            "aec_value",
            "Exposure (manual)",
            0,
            1200,
            true,
            "Manual shutter speed in sensor line units (0 = shortest, 1200 = longest). Only effective when Auto Exposure Control (AEC) is off.",
          )}
          ${this._checkCtrl(
            "agc",
            "Auto gain (AGC)",
            "Auto Gain Control (AGC): the camera automatically adjusts analog gain to help reach the target brightness. When off, gain is set manually below.",
          )}
          ${this._rangeCtrl(
            "agc_gain",
            "Gain (manual)",
            0,
            30,
            true,
            "Manual analog gain level (0–30). Only effective when Auto Gain Control (AGC) is off.",
          )}
          ${this._rangeCtrl(
            "gainceiling",
            "Gain ceiling",
            0,
            255,
            false,
            "Maximum analog gain the Auto Gain Control (AGC) may apply (raw 8-bit register value 0–255). Hardware power-on default is 248. Lower values restrict the AGC and reduce amplification in low light.",
          )}
          ${this._checkCtrl(
            "awb_gain",
            "AWB gain",
            "Apply the per-channel digital gains computed by Auto White Balance (AWB). Improves colour accuracy at the cost of a small reduction in dynamic range.",
          )}
          ${this._rangeCtrl(
            "sharpness",
            "Sharpness",
            -2,
            2,
            false,
            "Edge enhancement. Higher values increase perceived sharpness but may amplify noise.",
          )}
          ${this._rangeCtrl(
            "denoise",
            "Denoise",
            0,
            255,
            false,
            "Spatial noise reduction strength. Higher = smoother image with less fine detail.",
          )}
          ${this._checkCtrl(
            "bpc",
            "Black pixel correction",
            "Black Pixel Cancellation (BPC): detects and interpolates over stuck-dark (dead) pixels.",
          )}
          ${this._checkCtrl(
            "wpc",
            "White pixel correction",
            "White Pixel Cancellation (WPC): detects and interpolates over stuck-bright (hot) pixels.",
          )}
          ${this._checkCtrl(
            "raw_gma",
            "Raw gamma",
            "Raw Gamma (GMA): applies a gamma curve to sensor data before JPEG encoding, improving perceived dynamic range in highlights and shadows.",
          )}
          ${this._checkCtrl(
            "lenc",
            "Lens correction",
            "Lens Correction (LENC): compensates for vignetting by brightening the edges and corners to match the centre.",
          )}
          ${this._checkCtrl(
            "dcw",
            "Downsize crop (DCW)",
            "Downscale Crop Window (DCW): uses higher-quality pixel averaging when reducing to a lower resolution. Disabling uses faster but lower-quality subsampling.",
          )}
          ${this._checkCtrl("colorbar", "Colorbar test", "Replace the live image with a colour bar test pattern.")}
        </div>
        <input type="text" id="urlDisplay" class="url-display" readonly />
      </details>
      <div class="settings-save-bar">
        <button type="button" id="savePiconBtn">+ Save preset</button>
      </div>
    </details>
    <div class="settings-footer">
      <button type="button" id="resetAllBtn">Reset all</button>
      <span class="presets-bar">
        <span id="presetsList"></span>
      </span>
    </div>`;
  }

  // --- Event listener attachment for dynamically generated settings HTML ---

  _attachSettingsListeners(container) {
    // Hint overlay: click outside modal closes it; modal stops propagation; close button closes it.
    const overlay = container.querySelector("#hintOverlay");
    if (overlay) {
      overlay.addEventListener("click", () => this._closeHint());
      container.querySelector("#hintModal")?.addEventListener("click", e => e.stopPropagation());
      container.querySelector(".hint-close")?.addEventListener("click", () => this._closeHint());
    }

    // Hint buttons
    container.querySelectorAll(".hint-btn").forEach(btn => {
      btn.addEventListener("click", () => this._showHint(btn));
    });

    // Reset buttons (identified by data-reset-id attribute)
    container.querySelectorAll("[data-reset-id]").forEach(btn => {
      btn.addEventListener("click", () => this._resetCtrl(btn.dataset.resetId));
    });

    // Range inputs: update display on input, trigger restart on change
    container.querySelectorAll('input[type="range"]').forEach(el => {
      el.addEventListener("input", () => this._syncValue(el.id));
      el.addEventListener("change", () => this._restart());
    });

    // Checkboxes: sync dependents for auto-controls (aec, agc), then restart
    container.querySelectorAll('input[type="checkbox"]').forEach(el => {
      el.addEventListener("change", () => {
        if (el.id in AUTO_DEPS) {
          this._syncDependents();
        }
        this._restart();
      });
    });

    // Selects: rotate applies rotation without restarting stream; others restart
    container.querySelectorAll("select.ctrl-select").forEach(el => {
      el.addEventListener("change", () => {
        if (el.id === "rotate") {
          this._persistSettings();
          this._onApplyRotation?.();
        } else {
          this._restart();
        }
      });
    });

    container.querySelector("#savePiconBtn")?.addEventListener("click", () => this._savePreset());
    container.querySelector("#resetAllBtn")?.addEventListener("click", () => this._resetAll());

    const urlDisplay = container.querySelector("#urlDisplay");
    if (urlDisplay) {
      urlDisplay.addEventListener("click", () => {
        if (urlDisplay.selectionStart === urlDisplay.selectionEnd) {
          urlDisplay.select();
        }
      });
    }
  }

  _onDOMReady() {
    const container = document.getElementById("settingsContainer");
    if (container) {
      container.innerHTML = this._buildSettingsHTML();
      this._attachSettingsListeners(container);
      this._syncDependents(); // apply initial greyed state before any further overrides
      // The footer must be a direct child of #settingsArea (not inside the
      // scrolling #settingsContainer) so it stays pinned at the bottom on
      // desktop.  Move it up one level after injection.
      const footer = container.querySelector(".settings-footer");
      const settingsArea = container.parentElement;
      if (footer && settingsArea) {
        settingsArea.appendChild(footer);
      }
    }
    this._applySettings(this._defaults);
    this._loadSettings();
    this._updateUrlDisplay();
    this._loadPageOptions();
    const sd = document.getElementById("settingsDetails");
    const ad = document.getElementById("settingsAdvDetails");
    if (sd) {
      sd.addEventListener("toggle", () => this._savePageOptions());
    }
    if (ad) {
      ad.addEventListener("toggle", () => this._savePageOptions());
    }
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        this._closeHint();
      }
    });
    const resEl = document.getElementById("res");
    if (resEl) {
      resEl.addEventListener("change", () => this._restart());
    }
    const resResetBtn = document.getElementById("resReset");
    if (resResetBtn) {
      const defaultOpt = resEl ? Array.from(resEl.options).find(o => o.value === this._defaultRes) : null;
      resResetBtn.title = `Reset to ${defaultOpt ? defaultOpt.text : this._defaultRes}`;
      resResetBtn.addEventListener("click", () => this._resetRes());
    }
    this._renderPresets();
    this._onPageReady?.();
  }
}
