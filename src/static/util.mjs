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
