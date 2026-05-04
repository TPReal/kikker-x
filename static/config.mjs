import { docElem, openMenu, POST_REBOOT_RELOAD_MS, showToast } from "/util.mjs";

let _currentData = null;

// --- JSON rendering (syntax-highlighted) ---

function walk(node, indent, out) {
  const pad = "  ".repeat(indent);
  if (node === null) {
    out.push(`<span class="nul">null</span>`);
    return;
  }
  if (typeof node === "boolean") {
    out.push(`<span class="b">${node}</span>`);
    return;
  }
  if (typeof node === "number") {
    out.push(`<span class="n">${node}</span>`);
    return;
  }
  if (typeof node === "string") {
    out.push(`<span class="s">${escapeAndQuote(node)}</span>`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) {
      out.push("[]");
      return;
    }
    out.push("[\n");
    node.forEach((item, i) => {
      out.push(`${pad}  `);
      walk(item, indent + 1, out);
      if (i < node.length - 1) {
        out.push(",");
      }
      out.push("\n");
    });
    out.push(`${pad}]`);
    return;
  }
  const keys = Object.keys(node);
  if (keys.length === 0) {
    out.push("{}");
    return;
  }
  out.push("{\n");
  keys.forEach((k, i) => {
    out.push(`${pad}  <span class="k">${escapeAndQuote(k)}</span>: `);
    walk(node[k], indent + 1, out);
    if (i < keys.length - 1) {
      out.push(",");
    }
    out.push("\n");
  });
  out.push(`${pad}}`);
}

// JSON.stringify handles JSON escaping (\" for ", \\ for \, \n, \uXXXX, etc.)
// and wraps the result in quotes. Then HTML-escape for innerHTML safety.
function escapeAndQuote(s) {
  return escapeHtml(JSON.stringify(String(s)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function renderValue(value, indent) {
  const out = [];
  walk(value, indent, out);
  return out.join("");
}

// --- Comparison ---

// Literal deep equality via JSON.stringify (server emits canonical key order).
// Redacted placeholders compare equal to each other even if underlying secrets differ.
function equals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Rendering ---
//
// Each item gets column-level flag classes ("cfg-active", "cfg-default") plus,
// for fields, per-item flags ("cfg-different", "cfg-equal-to-default"). CSS
// decides what to do with them.

function colHeader(label, entry, isActive, colCls) {
  let meta = "";
  if (!entry) {
    meta += `<span class="cfg-version">(none)</span>`;
  } else if (entry.config === null && entry.schema_version === 0) {
    // Stored was deleted/cleared this session and isn't applied yet — not "outdated".
    meta += `<span class="cfg-version">(empty)</span>`;
  } else if (entry.config === null) {
    // Entry preserved for inspection but unusable at runtime — schema mismatch or parse failure.
    meta += `<span class="cfg-version cfg-version-mismatch">v${entry.schema_version} (outdated)</span>`;
  } else {
    meta += `<span class="cfg-version">v${entry.schema_version}</span>`;
  }
  meta += `<span class="cfg-tag cfg-tag-active">${isActive ? "active" : "inactive"}</span>`;
  return `<div class="cfg-col-hd ${colCls}"><div class="cfg-col-name">${escapeHtml(label)}</div>${meta}</div>`;
}

function brace(ch, colCls) {
  return `<div class="cfg-brace ${colCls}">${ch}</div>`;
}

// Top-level keys that get the "edit field" pencil on the stored column.
// `known_networks` is omitted from EDIT (inline per-entry only); it does get a
// section-level RESET icon — see networksRow.
const EDITABLE_FIELDS = new Set(["mdns", "fallback_access_point", "allow_cors", "auth", "allow_ota"]);

// Builds the small top-right "actions" container shown next to each field's value.
// Order is fixed per the spec: =default tag, edit pencil, reset arrow. Edit and
// reset are always rendered when the field is editable; reset is `disabled`
// when the value already equals firmware default (clicking would be a no-op).
function fieldActionsHtml({ key, editable, isEqualToDefault, includeEdit = true }) {
  if (!editable && !isEqualToDefault) {
    return "";
  }
  const tag = isEqualToDefault ? `<span class="cfg-tag cfg-tag-default">=default</span>` : "";
  let edit = "";
  if (editable) {
    edit = includeEdit
      ? `<button type="button" class="icon-btn" data-action="edit-field" data-field="${key}" title="Edit ${key}">✎</button>`
      : // Networks have no top-level edit; render a hidden placeholder so the reset
        // icon lines up with the regular fields' resets.
        `<button type="button" class="icon-btn" tabindex="-1" aria-hidden="true" style="visibility: hidden">✎</button>`;
  }
  const disabledAttr = isEqualToDefault ? " disabled" : "";
  const resetTitle = isEqualToDefault ? "Already at default" : `Reset ${key} to default`;
  const reset = editable
    ? `<button type="button" class="icon-btn" data-action="reset-field" data-field="${key}"${disabledAttr} title="${resetTitle}">↺</button>`
    : "";
  return `<span class="cfg-field-actions">${tag}${edit}${reset}</span>`;
}

function fieldRow(key, value, isLast, colCls, isDifferent, isEqualToDefault, editable) {
  const comma = isLast ? "" : ",";
  const valueHtml = renderValue(value, 1);
  const editableHere = editable && EDITABLE_FIELDS.has(key);
  const actions = fieldActionsHtml({ key, editable: editableHere, isEqualToDefault });
  const classes = ["cfg-field", colCls];
  if (isDifferent) {
    classes.push("cfg-different");
  }
  if (isEqualToDefault) {
    classes.push("cfg-equal-to-default");
  }
  return `
    <div class="${classes.join(" ")}">
      <pre class="cfg-json">  <span class="k cfg-section-key">${escapeAndQuote(key)}</span>: ${valueHtml}${comma}</pre>
      ${actions}
    </div>`;
}

// Inline editable rendering of the known_networks array on the stored column.
// Each entry has its own ✎ / ✕ buttons (shared .icon-btn class, same as hub's
// camera-card buttons); a `+ Add network` row sits at the bottom; a section-level
// reset (↺) lives in the field-actions container at the top-right. No top-level
// edit — known_networks is edited inline per entry.
function networksRow(entries, isLast, colCls, isDifferent, isEqualToDefault, editable) {
  const comma = isLast ? "" : ",";
  const classes = ["cfg-field", "cfg-networks", colCls];
  if (isDifferent) {
    classes.push("cfg-different");
  }
  if (isEqualToDefault) {
    classes.push("cfg-equal-to-default");
  }
  const list = Array.isArray(entries) ? entries : [];
  const actions = fieldActionsHtml({ key: "known_networks", editable, isEqualToDefault, includeEdit: false });
  let entriesHtml = `<pre class="cfg-json cfg-networks-open">  <span class="k cfg-section-key">"known_networks"</span>: [</pre>`;
  list.forEach((entry, i) => {
    const trail = i < list.length - 1 ? "," : "";
    const ssid = entry && typeof entry.ssid === "string" ? entry.ssid : "";
    const entryHtml = renderValue(entry, 2);
    // Split off the first line ("{") so the icons can sit inline next to it,
    // with the rest of the entry's body rendered as a separate <pre> below.
    const nl = entryHtml.indexOf("\n");
    const head = nl >= 0 ? entryHtml.substring(0, nl) : entryHtml;
    const body = nl >= 0 ? entryHtml.substring(nl + 1) : "";
    entriesHtml += `
      <div class="cfg-network-row">
        <div class="cfg-network-head">
          <pre class="cfg-json">    ${head}</pre>
          <button type="button" class="icon-btn" data-action="edit-network" data-ssid="${escapeHtml(ssid)}" title="Edit network">✎</button>
          <button type="button" class="icon-btn" data-action="delete-network" data-ssid="${escapeHtml(ssid)}" title="Delete network">✕</button>
        </div>
        <pre class="cfg-json cfg-network-body">${body}${trail}</pre>
      </div>`;
  });
  const closeBracket = `<pre class="cfg-json cfg-networks-close">  ]${comma}</pre>`;
  const addBtn = `<button type="button" class="cfg-network-add" data-action="add-network">+ Add network</button>`;
  return `<div class="${classes.join(" ")}">${actions}${entriesHtml}${closeBracket}${addBtn}</div>`;
}

function unavailableField(key, isLast, colCls) {
  const comma = isLast ? "" : ",";
  // "──" (two U+2500 box-drawing horizontals) draws a continuous line that
  // fills two monospace cells, instead of a lone em dash that looks too short.
  return `
    <div class="cfg-field cfg-unavailable ${colCls}">
      <pre class="cfg-json cfg-empty">  ${escapeAndQuote(key)}: ──${comma}</pre>
    </div>`;
}

// Builds a column descriptor {source, label, entry, isActive, isDefault} for a given source key.
// `source` is "active" | "stored" | "embedded" | "default".
function colForSource(data, source) {
  return {
    source,
    label: capitalize(source),
    entry: data[source] ?? null,
    isActive: data[source]?.is_active === true,
    isDefault: source === "default",
  };
}

function renderGrid(data, mode) {
  let left;
  let right;
  if (mode === "da") {
    left = colForSource(data, "default");
    right = colForSource(data, "active");
  } else if (mode === "sa") {
    left = colForSource(data, "stored");
    right = colForSource(data, "active");
  } else if (mode === "se") {
    left = colForSource(data, "stored");
    right = colForSource(data, "embedded");
  }
  const showToolbar = data.can_edit_stored === true && (left.source === "stored" || right.source === "stored");
  // Source on the opposite side of "stored" — used as the "Set to X" copy target.
  // Null if stored isn't on-screen (shouldn't happen when showToolbar is true).
  const otherSource = left.source === "stored" ? right.source : right.source === "stored" ? left.source : null;
  const storedExists = data.stored != null;

  const leftCfg = left.entry?.config;
  const rightCfg = right.entry?.config;
  const defaultCfg = data.default.config;
  const fieldOrder = Object.keys(defaultCfg);
  const n = fieldOrder.length;
  // null = not comparable (one side is unusable), true = differs, false = equal.
  const diffs = fieldOrder.map(key => {
    if (!leftCfg || !rightCfg) {
      return null;
    }
    return !equals(leftCfg[key], rightCfg[key]);
  });

  const parts = [];

  // Render one column's header, opening brace, fields, and closing brace.
  // DOM order is per-column (all of col 1, then col 2, then col 3) so dragging
  // within a column keeps selection in-column. Grid flow is column-based; row
  // count comes from --rows on the grid container.
  const editableStored = data.can_edit_stored === true;
  function renderColumn(side) {
    const cfg = side.entry?.config;
    const cls = [side.isActive && "cfg-active", side.isDefault && "cfg-default"].filter(Boolean).join(" ");
    const editable = editableStored && side.source === "stored";
    parts.push(colHeader(side.label, side.entry, side.isActive, cls));
    parts.push(brace("{", cls));
    fieldOrder.forEach((key, i) => {
      const isLast = i === n - 1;
      if (cfg) {
        const isEqDefault = equals(cfg[key], defaultCfg[key]);
        if (key === "known_networks" && editable) {
          parts.push(networksRow(cfg[key], isLast, cls, diffs[i], isEqDefault, editable));
        } else {
          parts.push(fieldRow(key, cfg[key], isLast, cls, diffs[i], isEqDefault, editable));
        }
      } else {
        parts.push(unavailableField(key, isLast, cls));
      }
    });
    parts.push(brace("}", cls));
    if (showToolbar) {
      // Every column needs a cell at this row (column-flow grid) — only the
      // stored column gets the actual buttons; the others get an empty spacer.
      parts.push(
        side.source === "stored"
          ? renderEditToolbar(otherSource, storedExists)
          : `<div class="cfg-toolbar-spacer"></div>`,
      );
    }
  }

  renderColumn(left);
  // Column 2: spacers align with the header, opening-brace, and closing-brace
  // rows; diff indicators fill the field rows between.
  parts.push(`<div class="cfg-diff cfg-diff-spacer"></div>`);
  parts.push(`<div class="cfg-diff cfg-diff-spacer"></div>`);
  fieldOrder.forEach((_key, i) => {
    let cls = "";
    let txt = "";
    if (diffs[i] === true) {
      cls = "cfg-different";
      txt = "≠";
    } else if (diffs[i] === false) {
      cls = "cfg-equal";
      txt = "=";
    }
    parts.push(`<div class="cfg-diff ${cls}">${txt}</div>`);
  });
  parts.push(`<div class="cfg-diff cfg-diff-spacer"></div>`);
  if (showToolbar) {
    // Middle column also needs an extra placeholder for the toolbar row.
    parts.push(`<div class="cfg-diff cfg-diff-spacer"></div>`);
  }
  renderColumn(right);

  docElem.cfgGrid.style.setProperty("--rows", n + 3 + (showToolbar ? 1 : 0));
  docElem.cfgGrid.innerHTML = parts.join("");
}

// Renders the edit toolbar as one grid cell: Add-network + Reset-menu. Success
// notifications come through the shared toast, not the toolbar. All buttons
// carry data-action so delegation on #cfgGrid can route events without
// rebinding after every re-render.
function renderEditToolbar(otherSource, storedExists) {
  // "Reset to <other>" only makes sense when the other column is a baseline source
  // we can copy verbatim — currently only "embedded". Active is the running-RAM
  // snapshot, which the device intentionally won't snapshot back into NVS;
  // default has its own entry above.
  const resetToOther =
    otherSource === "embedded"
      ? `<button type="button" data-action="reset-to" data-source="embedded">Reset to Embedded</button>`
      : "";
  // When no stored entry exists, surface a prominent "Create" — same effect as
  // Reset-to-Default, but skips the overwrite-confirm dialog (nothing to overwrite).
  const createBtn = !storedExists ? `<button type="button" data-action="create-stored">Create</button>` : "";
  return `
    <div class="cfg-toolbar">
      ${createBtn}
      <button type="button" data-action="open-import">Import…</button>
      <div class="menu-wrap">
        <button type="button" data-action="toggle-reset-menu">Reset ▾</button>
        <div class="menu-popover" data-reset-menu hidden>
          <button type="button" data-action="reset-to" data-source="default">Reset to Default</button>
          ${resetToOther}
          <hr class="menu-sep" />
          <button type="button" data-action="delete-stored">Delete</button>
        </div>
      </div>
    </div>`;
}

function renderMeta(data) {
  const parts = [
    `<span><span class="cfg-meta-label">Policy:</span><code>${escapeHtml(data.policy)}</code></span>`,
    `<span><span class="cfg-meta-label">Active:</span><span class="cfg-source-name">${escapeHtml(capitalize(data.active_source))}</span></span>`,
    `<span><span class="cfg-meta-label">Schema:</span><span class="cfg-version">v${data.schema_version}</span></span>`,
  ];
  if (data.stored?.is_modified) {
    parts.push(`
      <button type="button" class="cfg-modified-badge" data-action="restart"
        title="Stored config was changed this session but is not running yet. Click to restart and apply.">
        modified — restart to apply
      </button>`);
  }
  docElem.cfgMeta.innerHTML = parts.join("");
}

// --- Mode selection ---
//
// Mode availability + the default pick depend on what's present in the data.
// The view modes are:
//   - "se" Stored vs Embedded  — requires stored (real or can-edit) and embedded
//   - "sa" Stored vs Active    — requires stored (real or can-edit)
//   - "da" Default vs Active   — always available (active and default always exist)
//
// Stored-centric modes ("se"/"sa") show the edit toolbar under the stored column.
// "sa" also surfaces when stored is empty but editable — useful for an initial
// save on a LOAD_OR_* device with no NVS entry.

function availableModes(data) {
  const modes = [];
  const storedAvail = data.stored || data.can_edit_stored === true;
  if (storedAvail && data.embedded) {
    modes.push("se");
  }
  if (storedAvail) {
    modes.push("sa");
  }
  modes.push("da");
  return modes;
}

function defaultMode(data) {
  // Prefer "sa" when stored has pending changes — that's the divergence the user
  // most likely wants to see. Otherwise prefer Stored vs Embedded when both are
  // available, and fall back to Stored vs Active everywhere else (so the edit
  // toolbar stays reachable). "da" only when stored isn't there at all.
  if (data.stored?.is_modified) {
    return "sa";
  }
  const storedUsable = data.stored && data.stored.config !== null;
  if (storedUsable && data.embedded) {
    return "se";
  }
  const storedAvail = data.stored || data.can_edit_stored === true;
  return storedAvail ? "sa" : "da";
}

function applyModeAvailability(data, pick) {
  const avail = new Set(availableModes(data));
  const storedAvail = data.stored || data.can_edit_stored === true;
  for (const input of document.querySelectorAll('input[name="cfgMode"]')) {
    const ok = avail.has(input.value);
    input.disabled = !ok;
    input.parentElement.classList.toggle("cfg-mode-disabled", !ok);
    input.checked = input.value === pick;
    if (ok) {
      input.parentElement.removeAttribute("title");
    } else {
      const missing = [];
      if (!storedAvail && (input.value === "se" || input.value === "sa")) {
        missing.push("stored");
      }
      if (!data.embedded && input.value === "se") {
        missing.push("embedded");
      }
      input.parentElement.title = `${capitalize(missing.join(" and "))} config not available`;
    }
  }
}

function currentMode() {
  const checked = document.querySelector('input[name="cfgMode"]:checked');
  return checked ? checked.value : "se";
}

function onModeChange() {
  if (_currentData) {
    renderGrid(_currentData, currentMode());
  }
}

// --- Edit actions ---

// Converts a 204 success or 4xx error into a {ok, error} object. Body is only
// consumed on error (endpoints return 204 No Content on success).
async function sendEdit(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
  if (res.ok) {
    return { ok: true };
  }
  const text = await res.text().catch(() => "");
  return { ok: false, error: text || `HTTP ${res.status}` };
}

// ---- Add / edit network dialog ----

// One-shot PATCH /api/config/stored with a one-key body. Used by every
// field-level editor. On success: toast + reload; on failure: shown in dialog.
// Disables the dialog's form-submit button while the request is in flight and
// shows a generic "Saving…" toast so the user has visible feedback even on
// fast saves where the dialog vanishes immediately.
async function patchField(key, value, dialogErrElem) {
  const dialog = dialogErrElem?.closest("dialog");
  const submitBtn = dialog?.querySelector("button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = true;
  }
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("PATCH", "/api/config/stored", { [key]: value });
  if (submitBtn) {
    submitBtn.disabled = false;
  }
  if (!result.ok) {
    if (dialogErrElem) {
      showDialogError(dialogErrElem, result.error);
    }
    return false;
  }
  return true;
}

// `prefill`: null → blank Add form; object → Edit mode (SSID locked, other
// fields pre-populated; password input always blank — current value is redacted
// on the server, so the user must re-enter or leave blank for an open network).
function openAddNetworkDialog(prefill) {
  const form = docElem.cfgAddNetworkForm;
  form.reset();
  docElem.cfgAnError.hidden = true;
  const editing = !!prefill?.ssid;
  docElem.cfgAddNetworkDialog.querySelector("h3").textContent = editing
    ? `Edit network "${prefill.ssid}"`
    : "Add / replace WiFi network";
  docElem.cfgAnSsid.value = prefill?.ssid ?? "";
  docElem.cfgAnSsid.readOnly = editing;
  if (prefill?.static_ip) {
    docElem.cfgAnStaticIp.value = prefill.static_ip;
    docElem.cfgAnSubnet.value = prefill.subnet_mask ?? "";
    docElem.cfgAnGateway.value = prefill.gateway ?? "";
    docElem.cfgAnDns.value = prefill.dns ?? "";
  }
  docElem.cfgAddNetworkDialog.showModal();
  (editing ? docElem.cfgAnPassword : docElem.cfgAnSsid).focus();
}

async function submitAddNetwork(event) {
  event.preventDefault();
  // SSID's `required` attr blocks empty submits; we just trim what arrived.
  const ssid = docElem.cfgAnSsid.value.trim();
  const entry = {
    ssid,
    password: docElem.cfgAnPassword.value,
  };
  const staticIp = docElem.cfgAnStaticIp.value.trim();
  if (staticIp) {
    entry.static_ip = staticIp;
    const subnet = docElem.cfgAnSubnet.value.trim();
    const gw = docElem.cfgAnGateway.value.trim();
    const dns = docElem.cfgAnDns.value.trim();
    if (subnet) {
      entry.subnet_mask = subnet;
    }
    if (gw) {
      entry.gateway = gw;
    }
    if (dns) {
      entry.dns = dns;
    }
  }
  docElem.cfgAnSaveBtn.disabled = true;
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("PUT", "/api/config/stored/known_networks", entry);
  docElem.cfgAnSaveBtn.disabled = false;
  if (!result.ok) {
    showDialogError(docElem.cfgAnError, result.error);
    return;
  }
  docElem.cfgAddNetworkDialog.close();
  showToast(docElem.cfgToast, `Saved network "${ssid}".`);
  await load();
}

async function submitDeleteNetwork(ssid) {
  if (!ssid || !confirm(`Delete network "${ssid}" from the stored config?`)) {
    return;
  }
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("DELETE", `/api/config/stored/known_networks?ssid=${encodeURIComponent(ssid)}`);
  if (!result.ok) {
    showToast(docElem.cfgToast, `Delete failed: ${result.error}`);
    return;
  }
  showToast(docElem.cfgToast, `Removed network "${ssid}".`);
  await load();
}

// ---- Per-field editors ----

// Hardcoded editor per top-level key: each `open(currentValue)` displays a
// dialog and submits via patchField. Adding `null` via the dialog's "Reset to
// default" reverts that single field to firmware default on next boot.

const FIELD_EDITORS = {
  mdns: { open: openMdnsEditor },
  fallback_access_point: { open: openApEditor },
  allow_cors: { open: cur => openBoolEditor("allow_cors", "Allow CORS", cur) },
  auth: { open: openAuthEditor },
  allow_ota: { open: cur => openBoolEditor("allow_ota", "Allow OTA updates", cur) },
};

// --- mdns ---

function openMdnsEditor(current) {
  docElem.cfgMdnsInput.value = typeof current === "string" ? current : "";
  docElem.cfgMdnsError.hidden = true;
  docElem.cfgMdnsDialog.showModal();
  docElem.cfgMdnsInput.focus();
}

async function submitMdns(event) {
  event.preventDefault();
  const v = docElem.cfgMdnsInput.value.trim();
  // Empty string → null (firmware default = mDNS off, same effect as Reset).
  const value = v ? v : null;
  if (!(await patchField("mdns", value, docElem.cfgMdnsError))) {
    return;
  }
  docElem.cfgMdnsDialog.close();
  showToast(docElem.cfgToast, `Saved mdns.`);
  await load();
}

// --- bool (allow_cors / allow_ota) ---

let _boolEditorKey = null;

function openBoolEditor(key, title, current) {
  _boolEditorKey = key;
  docElem.cfgBoolTitle.textContent = title;
  docElem.cfgBoolLabel.textContent = title;
  docElem.cfgBoolCheckbox.checked = current === true;
  docElem.cfgBoolError.hidden = true;
  docElem.cfgBoolDialog.showModal();
}

async function submitBool(event) {
  event.preventDefault();
  const value = docElem.cfgBoolCheckbox.checked;
  if (!(await patchField(_boolEditorKey, value, docElem.cfgBoolError))) {
    return;
  }
  docElem.cfgBoolDialog.close();
  showToast(docElem.cfgToast, `Saved ${_boolEditorKey}.`);
  await load();
}

// --- fallback_access_point ---

function openApEditor(current) {
  // current may be: object {ssid, password}, false (disabled), or absent
  const obj = current && typeof current === "object" ? current : null;
  const enabled = obj !== null && current !== false;
  docElem.cfgApEnabled.checked = enabled;
  docElem.cfgApSsid.value = obj?.ssid ?? "";
  // Password mode: empty/null → open, "RANDOM" → random, else explicit.
  let mode = "random";
  if (obj?.password === null || obj?.password === "") {
    mode = "open";
  } else if (obj?.password && obj.password !== "RANDOM" && obj.password !== "***") {
    mode = "explicit";
  }
  for (const r of docElem.cfgApDialog.querySelectorAll('input[name="cfgApPwMode"]')) {
    r.checked = r.value === mode;
  }
  docElem.cfgApPassword.value = "";
  docElem.cfgApError.hidden = true;
  applyApFormState();
  docElem.cfgApDialog.showModal();
  (enabled ? docElem.cfgApSsid : docElem.cfgApEnabled).focus();
}

// Mirrors a single Enabled checkbox into the visual + disabled state of a
// `.cfg-disabled-section` block. Used by both the AP-fallback and auth dialogs.
function applyEnabledToggle(checkbox, detailContainer) {
  const enabled = checkbox.checked;
  detailContainer.classList.toggle("cfg-disabled-section", !enabled);
  for (const inp of detailContainer.querySelectorAll("input")) {
    inp.disabled = !enabled;
  }
}

function applyApFormState() {
  applyEnabledToggle(docElem.cfgApEnabled, docElem.cfgApDialog.querySelector(".cfg-ap-detail"));
  // Password input is gated by both the AP-enabled toggle and the password-mode
  // radio: only "explicit" mode uses it. `required` mirrors that so the browser
  // blocks empty-submit when explicit, and skips validation otherwise.
  const enabled = docElem.cfgApEnabled.checked;
  const explicit = docElem.cfgApDialog.querySelector('input[name="cfgApPwMode"]:checked')?.value === "explicit";
  docElem.cfgApPassword.disabled = !(enabled && explicit);
  docElem.cfgApPassword.required = enabled && explicit;
}

async function submitAp(event) {
  event.preventDefault();
  if (!docElem.cfgApEnabled.checked) {
    if (!(await patchField("fallback_access_point", false, docElem.cfgApError))) {
      return;
    }
  } else {
    // SSID `required` (browser-validated) — when we get here, ssid is non-empty.
    const ssid = docElem.cfgApSsid.value.trim();
    const mode = docElem.cfgApDialog.querySelector('input[name="cfgApPwMode"]:checked')?.value;
    const value = { ssid };
    if (mode === "open") {
      value.password = null;
    } else if (mode === "random") {
      value.password = "RANDOM";
    } else {
      // Password input is `required` in explicit mode (set by applyApFormState),
      // so the browser blocks an empty submit before we get here.
      value.password = docElem.cfgApPassword.value;
    }
    if (!(await patchField("fallback_access_point", value, docElem.cfgApError))) {
      return;
    }
  }
  docElem.cfgApDialog.close();
  showToast(docElem.cfgToast, "Saved fallback_access_point.");
  await load();
}

// --- auth ---

function openAuthEditor(current) {
  const obj = current && typeof current === "object" ? current : null;
  docElem.cfgAuthEnabled.checked = obj !== null;
  docElem.cfgAuthUsername.value = obj?.username ?? "";
  docElem.cfgAuthPassword.value = "";
  docElem.cfgAuthError.hidden = true;
  applyAuthFormState();
  docElem.cfgAuthDialog.showModal();
  (obj ? docElem.cfgAuthUsername : docElem.cfgAuthEnabled).focus();
}

function applyAuthFormState() {
  applyEnabledToggle(docElem.cfgAuthEnabled, docElem.cfgAuthDialog.querySelector(".cfg-auth-detail"));
}

async function submitAuth(event) {
  event.preventDefault();
  if (!docElem.cfgAuthEnabled.checked) {
    if (!(await patchField("auth", null, docElem.cfgAuthError))) {
      return;
    }
  } else {
    // Both fields `required` (browser-validated) — non-empty by the time we run.
    // Cleartext password sent over HTTP — the device hashes server-side. crypto.subtle
    // isn't available on non-secure contexts, and HTTP Basic Auth already exposes the
    // password on every authenticated request, so this doesn't change the threat model.
    const username = docElem.cfgAuthUsername.value.trim();
    const password = docElem.cfgAuthPassword.value;
    if (!(await patchField("auth", { username, password }, docElem.cfgAuthError))) {
      return;
    }
  }
  docElem.cfgAuthDialog.close();
  showToast(docElem.cfgToast, "Saved auth.");
  await load();
}

// ---- Import dialog (paste JSON → PATCH or Replace) ----

function allowedFieldKeys() {
  const def = _currentData?.default?.config;
  return def ? Object.keys(def) : [];
}

function openImportDialog() {
  const allowed = allowedFieldKeys();
  docElem.cfgImportText.value = "";
  docElem.cfgImportError.hidden = true;
  docElem.cfgImportAllowedKeys.innerHTML = allowed.map(k => `<code>${escapeHtml(k)}</code>`).join(", ");
  for (const r of docElem.cfgImportDialog.querySelectorAll('input[name="cfgImportMode"]')) {
    r.checked = r.value === "patch";
  }
  docElem.cfgImportDialog.showModal();
  docElem.cfgImportText.focus();
}

async function submitImport() {
  let parsed;
  try {
    parsed = JSON.parse(docElem.cfgImportText.value);
  } catch (e) {
    showDialogError(docElem.cfgImportError, `Invalid JSON: ${e.message}`);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    showDialogError(docElem.cfgImportError, "Top-level must be a JSON object.");
    return;
  }
  const allowed = new Set(allowedFieldKeys());
  const unknown = Object.keys(parsed).filter(k => !allowed.has(k));
  if (unknown.length) {
    showDialogError(docElem.cfgImportError, `Unknown key(s): ${unknown.join(", ")}.`);
    return;
  }
  let body = parsed;
  const mode = docElem.cfgImportDialog.querySelector('input[name="cfgImportMode"]:checked')?.value;
  if (mode === "replace") {
    // Pad the patch with explicit nulls so the server clears every field the
    // user did not include — net effect is "stored = the imported object,
    // missing keys back to firmware defaults".
    body = { ...parsed };
    for (const k of allowed) {
      if (!(k in body)) {
        body[k] = null;
      }
    }
  }
  docElem.cfgImportConfirmBtn.disabled = true;
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("PATCH", "/api/config/stored", body);
  docElem.cfgImportConfirmBtn.disabled = false;
  if (!result.ok) {
    showDialogError(docElem.cfgImportError, result.error);
    return;
  }
  docElem.cfgImportDialog.close();
  showToast(docElem.cfgToast, mode === "replace" ? "Stored config replaced." : "Stored config patched.");
  await load();
}

// ---- Reset-field dialog (one shared confirm modal for all per-field resets) ----

let _pendingResetField = null;

function openResetFieldDialog(key) {
  _pendingResetField = key;
  docElem.cfgRfTitle.textContent = `Reset ${key} to default`;
  docElem.cfgRfBody.textContent = "Saved to the stored config; takes effect on next boot.";
  docElem.cfgRfError.hidden = true;
  docElem.cfgRfConfirmBtn.disabled = false;
  docElem.cfgResetFieldDialog.showModal();
}

async function submitResetField() {
  const key = _pendingResetField;
  if (!key) {
    return;
  }
  docElem.cfgRfConfirmBtn.disabled = true;
  if (!(await patchField(key, null, docElem.cfgRfError))) {
    docElem.cfgRfConfirmBtn.disabled = false;
    return;
  }
  docElem.cfgResetFieldDialog.close();
  _pendingResetField = null;
  showToast(docElem.cfgToast, `Reset ${key} to default.`);
  await load();
}

// ---- Restart dialog ----

function openRestartDialog() {
  docElem.cfgRsBody.textContent =
    "The device will reboot and start running the stored config. Network connections drop for a few seconds; " +
    "this page will reload automatically.";
  docElem.cfgRsError.hidden = true;
  docElem.cfgRsConfirmBtn.disabled = false;
  docElem.cfgRsCancelBtn.disabled = false;
  docElem.cfgRestartDialog.showModal();
}

async function submitRestart() {
  docElem.cfgRsConfirmBtn.disabled = true;
  docElem.cfgRsCancelBtn.disabled = true;
  try {
    // Best-effort: the device may close the connection mid-response, which
    // surfaces as a fetch error — still treat as "restart in progress".
    await fetch("/api/restart", { method: "POST" });
  } catch (_e) {
    // ignore; we'll reload anyway
  }
  docElem.cfgRsBody.textContent = "Device is restarting. This page will reload in a few seconds…";
  // location.reload() preserves the URL, so we land back on /config.
  setTimeout(() => location.reload(), POST_REBOOT_RELOAD_MS);
}

// ---- Reset-to (copy-from-source) dialog ----

// Source-specific hint shown inside the overwrite-confirm dialog.
const RESET_TO_BODY = {
  embedded: "Overwrites the stored config with the firmware-embedded config (real passwords preserved).",
  default:
    "Overwrites the stored config with the firmware defaults — no WiFi, no auth, AP fallback with a random password.",
};

let _pendingResetSource = null;

function openResetToDialog(source) {
  const label = capitalize(source);
  _pendingResetSource = source;
  docElem.cfgStTitle.textContent = `Reset stored config to ${label}?`;
  docElem.cfgStBody.textContent = RESET_TO_BODY[source] ?? `Overwrites the stored config with the ${label} source.`;
  docElem.cfgStError.hidden = true;
  docElem.cfgSetToDialog.showModal();
}

async function submitResetTo() {
  const source = _pendingResetSource;
  if (!source) {
    return;
  }
  docElem.cfgStConfirmBtn.disabled = true;
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("POST", `/api/config/stored/copy?from=${encodeURIComponent(source)}`);
  docElem.cfgStConfirmBtn.disabled = false;
  if (!result.ok) {
    showDialogError(docElem.cfgStError, result.error);
    return;
  }
  docElem.cfgSetToDialog.close();
  _pendingResetSource = null;
  showToast(docElem.cfgToast, `Stored config reset to ${source}.`);
  await load();
}

// ---- Create-stored (no-confirmation copy from default) ----

async function submitCreateStored() {
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("POST", "/api/config/stored/copy?from=default");
  if (!result.ok) {
    showToast(docElem.cfgToast, `Create failed: ${result.error}`);
    return;
  }
  showToast(docElem.cfgToast, "Stored config created from defaults.");
  await load();
}

// ---- Delete dialog ----

// What happens on next boot after a DELETE, by policy. Only policies that expose
// can_edit_stored: true reach this dialog, so we only cover LOAD_OR_* variants.
const DELETE_POLICY_EFFECT = {
  LOAD_OR_USE_EMBEDDED: "the firmware-embedded config will be used on next boot.",
  LOAD_OR_STORE_EMBEDDED: "the firmware-embedded config will be used on next boot and re-saved to the stored config.",
  LOAD_OR_USE_DEFAULT: "the device will boot with firmware defaults (AP fallback, random password).",
  LOAD_OR_FAIL:
    "the device will refuse to start, and recovery requires <strong>re-flashing over USB</strong> — no network " +
    "endpoint is reachable until firmware is running again.",
};

function openDeleteDialog() {
  const policy = _currentData?.policy ?? "";
  const effect = DELETE_POLICY_EFFECT[policy] ?? "the device will fall back according to the compiled policy.";
  docElem.cfgDelPolicyNote.innerHTML = `Policy is <code>${escapeHtml(policy)}</code>, which means ${effect}`;
  docElem.cfgDelError.hidden = true;
  docElem.cfgDeleteDialog.showModal();
}

async function submitDelete() {
  docElem.cfgDelConfirmBtn.disabled = true;
  showToast(docElem.cfgToast, "Saving…");
  const result = await sendEdit("DELETE", "/api/config/stored");
  docElem.cfgDelConfirmBtn.disabled = false;
  if (!result.ok) {
    showDialogError(docElem.cfgDelError, result.error);
    return;
  }
  docElem.cfgDeleteDialog.close();
  showToast(docElem.cfgToast, "Stored config deleted.");
  await load();
}

function showDialogError(elem, msg) {
  elem.textContent = msg;
  elem.hidden = false;
}

// --- Load & init ---

async function load() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const prev = _currentData ? currentMode() : null;
    _currentData = data;
    renderMeta(data);
    const avail = new Set(availableModes(data));
    const pick = avail.has(prev) ? prev : defaultMode(data);
    applyModeAvailability(data, pick);
    renderGrid(data, pick);
    docElem.cfgControls.hidden = false;
    docElem.cfgGrid.hidden = false;
    docElem.cfgError.hidden = true;
  } catch (e) {
    docElem.cfgMeta.textContent = "";
    docElem.cfgError.hidden = false;
    docElem.cfgError.textContent = `Failed to load config: ${e.message}`;
  }
}

for (const input of document.querySelectorAll('input[name="cfgMode"]')) {
  input.addEventListener("change", onModeChange);
}

// Edit buttons live inside the grid and are re-rendered on every mode change.
// Delegation on the grid container lets us bind once without chasing handles.
function closeAllResetMenus() {
  for (const m of docElem.cfgGrid.querySelectorAll("[data-reset-menu]")) {
    m.hidden = true;
  }
}

docElem.cfgGrid.addEventListener("click", ev => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) {
    return;
  }
  const action = btn.dataset.action;
  if (action === "toggle-reset-menu") {
    ev.stopPropagation();
    const menu = btn.parentElement.querySelector("[data-reset-menu]");
    const willOpen = menu.hidden;
    closeAllResetMenus();
    if (willOpen) {
      openMenu(menu);
    }
    return;
  }
  // All other actions close any open menu first, then dispatch.
  closeAllResetMenus();
  if (action === "add-network") {
    openAddNetworkDialog(null);
  } else if (action === "edit-network") {
    const ssid = btn.dataset.ssid;
    const entry = (storedNetworks() ?? []).find(e => e && e.ssid === ssid);
    openAddNetworkDialog(entry ?? { ssid });
  } else if (action === "delete-network") {
    submitDeleteNetwork(btn.dataset.ssid);
  } else if (action === "edit-field") {
    const ed = FIELD_EDITORS[btn.dataset.field];
    if (ed) {
      ed.open(_currentData?.stored?.config?.[btn.dataset.field]);
    }
  } else if (action === "reset-field") {
    openResetFieldDialog(btn.dataset.field);
  } else if (action === "open-import") {
    openImportDialog();
  } else if (action === "delete-stored") {
    openDeleteDialog();
  } else if (action === "reset-to") {
    openResetToDialog(btn.dataset.source);
  } else if (action === "create-stored") {
    submitCreateStored();
  }
});

function storedNetworks() {
  return _currentData?.stored?.config?.known_networks;
}

// Clicks outside the grid (including outside any menu) dismiss open menus.
document.addEventListener("click", closeAllResetMenus);

docElem.cfgStConfirmBtn.addEventListener("click", submitResetTo);
docElem.cfgStCancelBtn.addEventListener("click", () => docElem.cfgSetToDialog.close());

docElem.cfgRsConfirmBtn.addEventListener("click", submitRestart);
docElem.cfgRsCancelBtn.addEventListener("click", () => docElem.cfgRestartDialog.close());

// The "modified — restart to apply" badge is rendered into cfgMeta and replaced
// on every load(); delegation here avoids rebinding after each render.
docElem.cfgMeta.addEventListener("click", ev => {
  if (ev.target.closest("[data-action='restart']")) {
    openRestartDialog();
  }
});

docElem.cfgAddNetworkForm.addEventListener("submit", submitAddNetwork);
docElem.cfgAnCancelBtn.addEventListener("click", () => docElem.cfgAddNetworkDialog.close());

docElem.cfgDelConfirmBtn.addEventListener("click", submitDelete);
docElem.cfgDelCancelBtn.addEventListener("click", () => docElem.cfgDeleteDialog.close());

docElem.cfgMdnsForm.addEventListener("submit", submitMdns);
docElem.cfgMdnsCancelBtn.addEventListener("click", () => docElem.cfgMdnsDialog.close());

docElem.cfgBoolForm.addEventListener("submit", submitBool);
docElem.cfgBoolCancelBtn.addEventListener("click", () => docElem.cfgBoolDialog.close());

docElem.cfgApForm.addEventListener("submit", submitAp);
docElem.cfgApCancelBtn.addEventListener("click", () => docElem.cfgApDialog.close());
docElem.cfgApEnabled.addEventListener("change", applyApFormState);
for (const r of docElem.cfgApDialog.querySelectorAll('input[name="cfgApPwMode"]')) {
  r.addEventListener("change", applyApFormState);
}

docElem.cfgAuthForm.addEventListener("submit", submitAuth);
docElem.cfgAuthCancelBtn.addEventListener("click", () => docElem.cfgAuthDialog.close());
docElem.cfgAuthEnabled.addEventListener("change", applyAuthFormState);

docElem.cfgRfConfirmBtn.addEventListener("click", submitResetField);
docElem.cfgRfCancelBtn.addEventListener("click", () => docElem.cfgResetFieldDialog.close());

docElem.cfgImportConfirmBtn.addEventListener("click", submitImport);
docElem.cfgImportCancelBtn.addEventListener("click", () => docElem.cfgImportDialog.close());

load();
