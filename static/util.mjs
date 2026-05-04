export function compareVersion(a, b) {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (aa[i] || 0) - (bb[i] || 0);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  return 0;
}

// Time to wait after triggering a device-side reboot (POST /api/restart, OTA
// flash) before reloading the page. Long enough for boot + WiFi reconnect +
// mDNS to come back; the network is unreachable for several seconds.
export const POST_REBOOT_RELOAD_MS = 8000;

// Reveals a hidden popover/menu and nudges it back inside the viewport when it
// would overflow. Pass any element that's `hidden` and absolutely-positioned by
// its parent (e.g. our .menu-popover). Use `elem.hidden = true` to close.
const VIEWPORT_MARGIN = 8;
export function openMenu(elem) {
  // Reset any nudge from a previous open so we measure the natural position.
  elem.style.removeProperty("transform");
  elem.style.removeProperty("top");
  elem.style.removeProperty("bottom");
  elem.hidden = false;
  const r = elem.getBoundingClientRect();
  let dx = 0;
  if (r.right > innerWidth - VIEWPORT_MARGIN) {
    dx = innerWidth - VIEWPORT_MARGIN - r.right;
  } else if (r.left < VIEWPORT_MARGIN) {
    dx = VIEWPORT_MARGIN - r.left;
  }
  if (dx) {
    elem.style.transform = `translateX(${dx}px)`;
  }
  // If opening downward would clip the bottom, flip above the anchor instead.
  // (Re-measure in case the horizontal shift changed wrapping; usually it didn't.)
  if (elem.getBoundingClientRect().bottom > innerHeight - VIEWPORT_MARGIN) {
    elem.style.top = "auto";
    elem.style.bottom = "calc(100% - 1px)";
  }
}

// Shows a transient toast inside `elem` (a <div class="toast" popover="manual">).
// Replaces any visible toast, fades after 4s. The 400ms fade matches the CSS
// transition duration on .toast.
let _toastTimer = null;
export function showToast(elem, message) {
  elem.textContent = message;
  elem.classList.remove("fade");
  if (!elem.matches(":popover-open")) {
    elem.showPopover();
  }
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    elem.classList.add("fade");
    _toastTimer = setTimeout(() => elem.hidePopover(), 400);
  }, 4000);
}

export const docElem = new Proxy(
  {},
  {
    get(target, id) {
      if (typeof id !== "string") {
        return undefined;
      }
      const cached = target[id];
      if (cached) {
        return cached;
      }
      const elems = document.querySelectorAll(`#${CSS.escape(id)}`);
      if (elems.length !== 1) {
        throw new Error(`Expected exactly 1 element with id "${id}", found ${elems.length}`);
      }
      const elem = elems[0];
      target[id] = elem;
      return elem;
    },
  },
);
