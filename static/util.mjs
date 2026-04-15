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
