/** DOM helpers serialized with the tutorial measurement into the page. */
export function measurementTools() {
  const box = (node) => {
    if (!node) return null;
    const { left, top, right, bottom, width, height } =
      node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const pointable = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden" ||
        node.hidden ||
        node.hasAttribute("inert") ||
        node.getAttribute("aria-hidden") === "true"
      )
        return false;
    }
    return true;
  };
  const describe = (node) => {
    if (!node) return "nothing";
    const id = node.id ? `#${node.id}` : "";
    const first = String(node.getAttribute("class") ?? "").split(" ")[0];
    return `${node.tagName.toLowerCase()}${id}${first ? `.${first}` : ""}`;
  };
  const viewport = {
    width: document.documentElement.clientWidth,
    height: innerHeight,
  };
  // The part of the control a person could press: its box inside the screen
  // and inside the aperture the product opened for it.
  const visiblePart = (control, ring) => {
    const parts = [
      box(control),
      { left: 0, top: 0, right: viewport.width, bottom: viewport.height },
    ];
    for (let node = control.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (!clipX && !clipY) continue;
      const bounds = node.getBoundingClientRect();
      parts.push({
        left: clipX ? bounds.left + node.clientLeft : Number.NEGATIVE_INFINITY,
        right: clipX
          ? bounds.left + node.clientLeft + node.clientWidth
          : Number.POSITIVE_INFINITY,
        top: clipY ? bounds.top + node.clientTop : Number.NEGATIVE_INFINITY,
        bottom: clipY
          ? bounds.top + node.clientTop + node.clientHeight
          : Number.POSITIVE_INFINITY,
      });
    }
    if (ring) parts.push(ring);
    const left = Math.max(...parts.map((part) => part.left));
    const top = Math.max(...parts.map((part) => part.top));
    const right = Math.min(...parts.map((part) => part.right));
    const bottom = Math.min(...parts.map((part) => part.bottom));
    return right > left && bottom > top
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  };
  const probeControl = (control, ring) => {
    const part = visiblePart(control, ring);
    if (!part) return { visible: false };
    const x = (part.left + part.right) / 2;
    const y = (part.top + part.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      visible: true,
      x: Math.round(x),
      y: Math.round(y),
      hit: describe(hit),
      onControl: Boolean(hit) && control.contains(hit),
      onCard: Boolean(hit?.closest(".coach__card")),
      onDim: Boolean(hit?.classList.contains("coach__dim")),
    };
  };
  return { box, pointable, viewport, visiblePart, probeControl };
}
