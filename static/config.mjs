import { docElem } from "/util.mjs";

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
  if (entry) {
    // A non-null entry with a null config means the server preserved it for
    // inspection but can't use it at runtime (schema mismatch or parse failure).
    const unusable = entry.config === null;
    const cls = unusable ? " cfg-version-mismatch" : "";
    const suffix = unusable ? " (outdated)" : "";
    meta += `<span class="cfg-version${cls}">v${entry.schema_version}${suffix}</span>`;
  } else {
    meta += `<span class="cfg-version">(none)</span>`;
  }
  meta += `<span class="cfg-tag cfg-tag-active">${isActive ? "active" : "inactive"}</span>`;
  return `<div class="cfg-col-hd ${colCls}"><h2>${escapeHtml(label)}</h2>${meta}</div>`;
}

function brace(ch, colCls) {
  return `<div class="cfg-brace ${colCls}">${ch}</div>`;
}

function fieldRow(key, value, isLast, colCls, isDifferent, isEqualToDefault) {
  const comma = isLast ? "" : ",";
  const valueHtml = renderValue(value, 1);
  const tag = isEqualToDefault ? `<span class="cfg-tag cfg-tag-default">= default</span>` : "";
  const classes = ["cfg-field", colCls];
  if (isDifferent) {
    classes.push("cfg-different");
  }
  if (isEqualToDefault) {
    classes.push("cfg-equal-to-default");
  }
  return (
    `<div class="${classes.join(" ")}">` +
    `<pre class="cfg-json">  <span class="k cfg-section-key">${escapeAndQuote(key)}</span>: ${valueHtml}${comma}</pre>` +
    `${tag}</div>`
  );
}

function unavailableField(key, isLast, colCls) {
  const comma = isLast ? "" : ",";
  // "──" (two U+2500 box-drawing horizontals) draws a continuous line that
  // fills two monospace cells, instead of a lone em dash that looks too short.
  return (
    `<div class="cfg-field cfg-unavailable ${colCls}">` +
    `<pre class="cfg-json cfg-empty">  ${escapeAndQuote(key)}: ──${comma}</pre></div>`
  );
}

function renderGrid(data, mode) {
  let left;
  let right;

  // isActive is taken straight from the source entry's is_active flag (set by
  // the server based on policy). Multiple sources can be active at once in
  // STORE policies, where stored is kept in sync with embedded.
  if (mode === "da") {
    // Default vs Active: left is always Default, right is the primary read
    // source (active_source) — a canonical pick even when two sources are flagged active.
    const srcKey = data.active_source;
    left = {
      label: "Default",
      entry: data.default,
      isActive: data.default?.is_active === true,
      isDefault: true,
    };
    right = {
      label: srcKey.charAt(0).toUpperCase() + srcKey.slice(1),
      entry: data[srcKey],
      isActive: data[srcKey]?.is_active === true,
      isDefault: srcKey === "default",
    };
  } else {
    // Stored vs Embedded: each column's active flag comes from its own entry.
    left = {
      label: "Stored",
      entry: data.stored,
      isActive: data.stored?.is_active === true,
      isDefault: false,
    };
    right = {
      label: "Embedded",
      entry: data.embedded,
      isActive: data.embedded?.is_active === true,
      isDefault: false,
    };
  }

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
  function renderColumn(side) {
    const cfg = side.entry?.config;
    const cls = [side.isActive && "cfg-active", side.isDefault && "cfg-default"].filter(Boolean).join(" ");
    parts.push(colHeader(side.label, side.entry, side.isActive, cls));
    parts.push(brace("{", cls));
    fieldOrder.forEach((key, i) => {
      const isLast = i === n - 1;
      if (cfg) {
        const isEqDefault = equals(cfg[key], defaultCfg[key]);
        parts.push(fieldRow(key, cfg[key], isLast, cls, diffs[i], isEqDefault));
      } else {
        parts.push(unavailableField(key, isLast, cls));
      }
    });
    parts.push(brace("}", cls));
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
  renderColumn(right);

  docElem.cfgGrid.style.setProperty("--rows", n + 3);
  docElem.cfgGrid.innerHTML = parts.join("");
}

function renderMeta(data) {
  docElem.cfgMeta.innerHTML =
    `<span><span class="cfg-meta-label">Policy:</span><code>${escapeHtml(data.policy)}</code></span>` +
    `<span><span class="cfg-meta-label">Active:</span><code>${escapeHtml(data.active_source)}</code></span>` +
    `<span><span class="cfg-meta-label">Schema:</span><code>v${data.schema_version}</code></span>`;
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

async function load() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    _currentData = data;
    renderMeta(data);
    // Prefer Default vs Active on start when Stored vs Embedded wouldn't be
    // useful: no stored entry, stored is outdated, or active is default (which
    // implies one of the above). Default always has valid config to compare.
    const storedUnusable = !data.stored || data.stored.config === null;
    if (storedUnusable) {
      const daRadio = document.querySelector('input[name="cfgMode"][value="da"]');
      if (daRadio) {
        daRadio.checked = true;
      }
    }
    renderGrid(data, currentMode());
    docElem.cfgControls.hidden = false;
    docElem.cfgGrid.hidden = false;
  } catch (e) {
    docElem.cfgMeta.textContent = "";
    docElem.cfgError.hidden = false;
    docElem.cfgError.textContent = `Failed to load config: ${e.message}`;
  }
}

for (const input of document.querySelectorAll('input[name="cfgMode"]')) {
  input.addEventListener("change", onModeChange);
}

load();
