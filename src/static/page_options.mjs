const PAGE_OPTIONS_KEY = "pageOptions";

export function getPageOptions() {
  try {
    return JSON.parse(localStorage.getItem(PAGE_OPTIONS_KEY)) || {};
  } catch (_e) {
    return {};
  }
}

export function patchPageOptions(patch) {
  try {
    localStorage.setItem(PAGE_OPTIONS_KEY, JSON.stringify({ ...getPageOptions(), ...patch }));
  } catch (e) {
    console.warn("patchPageOptions:", e);
  }
}
