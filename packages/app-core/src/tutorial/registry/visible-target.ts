/** The visible part of a target, after the viewport and scrollports clip it. */
export function isPointable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      style.opacity === "0" ||
      node.hidden ||
      node.hasAttribute("inert") ||
      node.getAttribute("aria-hidden") === "true"
    )
      return false;
  }
  return true;
}

type Edges = { left: number; top: number; right: number; bottom: number };
export type VisibleTargetRect = Readonly<
  Edges & { width: number; height: number }
>;

function clipToScrollport(box: Edges, node: HTMLElement, view: Window): Edges {
  const style = view.getComputedStyle(node);
  const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
  const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
  if (!clipX && !clipY) return box;
  const bounds = node.getBoundingClientRect();
  return {
    left: clipX ? Math.max(box.left, bounds.left + node.clientLeft) : box.left,
    right: clipX
      ? Math.min(box.right, bounds.left + node.clientLeft + node.clientWidth)
      : box.right,
    top: clipY ? Math.max(box.top, bounds.top + node.clientTop) : box.top,
    bottom: clipY
      ? Math.min(box.bottom, bounds.top + node.clientTop + node.clientHeight)
      : box.bottom,
  };
}

export function visibleTargetRect(
  element: HTMLElement,
): VisibleTargetRect | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  const box = element.getBoundingClientRect();
  const viewport = view.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  let edges = {
    left: Math.max(viewportLeft, box.left),
    top: Math.max(viewportTop, box.top),
    right: Math.min(
      viewportLeft + (viewport?.width ?? view.innerWidth),
      box.right,
    ),
    bottom: Math.min(
      viewportTop + (viewport?.height ?? view.innerHeight),
      box.bottom,
    ),
  };
  for (let node = element.parentElement; node; node = node.parentElement) {
    edges = clipToScrollport(edges, node, view);
  }
  const { left, top, right, bottom } = edges;
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}
