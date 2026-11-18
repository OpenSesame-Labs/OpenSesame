/**
 * The functions the runner injects into the page it is driving, one per verb.
 *
 * `scripting.executeScript({ func })` serializes a function's source and runs
 * it in the page, so **each function here is self-contained**: it reaches for
 * nothing outside its own body — no import, no module-level helper, no
 * closure. They are written against the page's `document` global, which is
 * what lets a test run the very same functions against a jsdom document.
 *
 * They run in the extension's isolated world, never the page's, so page script
 * cannot call them or replace what they call. The one thing that crosses in is
 * the value `pfFill` writes — which is what filling a field is. Nothing a
 * function returns is a field's value: a verdict, a count, a layout signature
 * or markup with every value stripped.
 */

export type PageVerdict = "ok" | "timeout" | "invalid";

/** Wait for `selector` to match something, up to `timeoutMs`. */
export function pfWaitFor(
  selector: string,
  timeoutMs: number,
  expectedOrigin: string,
): Promise<PageVerdict> {
  if (document.defaultView?.location.origin !== expectedOrigin) {
    return Promise.reject(new Error("off_origin"));
  }
  return new Promise((resolve) => {
    const present = (): boolean | null => {
      try {
        return document.querySelector(selector) !== null;
      } catch {
        return null;
      }
    };
    const first = present();
    if (first === null) {
      resolve("invalid");
      return;
    }
    if (first) {
      resolve("ok");
      return;
    }
    const finish = (verdict: PageVerdict) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(verdict);
    };
    const observer = new MutationObserver(() => {
      if (present()) finish("ok");
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/** Write `value` into the text field at `selector`, as a person typing would. */
export function pfFill(
  selector: string,
  value: string,
  expectedOrigin: string,
): "ok" | "no_such_field" | "invalid" {
  const win = document.defaultView;
  if (!win) return "no_such_field";
  // This runs in the destination document, after executeScript has selected
  // it. A background tab check alone can race a navigation to another origin.
  if (win.location.origin !== expectedOrigin) throw new Error("off_origin");
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return "invalid";
  }
  if (!element) return "no_such_field";
  const field =
    element instanceof win.HTMLInputElement ||
    element instanceof win.HTMLTextAreaElement
      ? element
      : null;
  if (!field) return "no_such_field";
  const fillable = (): boolean => {
    const kind =
      field instanceof win.HTMLInputElement
        ? (field.type || "text").toLowerCase()
        : "textarea";
    const kinds = [
      "text",
      "password",
      "email",
      "tel",
      "search",
      "url",
      "textarea",
    ];
    if (!kinds.includes(kind) || field.disabled || field.readOnly) return false;
    const style = win.getComputedStyle(field);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  if (!fillable()) return "no_such_field";
  field.focus();
  // Focus can synchronously invoke page handlers that move or detach a field.
  const leftAuthorizedPage = () =>
    win.location.origin !== expectedOrigin ||
    field.ownerDocument !== document ||
    !field.isConnected;
  if (leftAuthorizedPage()) {
    throw new Error("off_origin");
  }
  if (!fillable()) return "no_such_field";
  // The prototype's setter, so a framework that wraps `value` still hears it.
  const proto =
    field instanceof win.HTMLInputElement
      ? win.HTMLInputElement.prototype
      : win.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new win.Event("input", { bubbles: true }));
  field.dispatchEvent(new win.Event("change", { bubbles: true }));
  return "ok";
}

/**
 * Whether the field at `selector` holds `expected`. Answered here, where both
 * are known, so the page's value is compared and never returned.
 */
export function pfPresence(
  selector: string,
  expected: string,
  expectedOrigin: string,
): "present" | "absent" | "mismatch" | "invalid" {
  const win = document.defaultView;
  if (!win) return "absent";
  if (win.location.origin !== expectedOrigin) throw new Error("off_origin");
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return "invalid";
  }
  if (!element) return "absent";
  const field =
    element instanceof win.HTMLInputElement ||
    element instanceof win.HTMLTextAreaElement
      ? element
      : null;
  if (!field || field.value === "") return "absent";
  return field.value === expected ? "present" : "mismatch";
}

/** Press the control at `selector`: submit a form, click anything else. */
export function pfSubmit(
  selector: string,
  expectedOrigin: string,
): "ok" | "no_such_element" | "invalid" | "off_origin" {
  const win = document.defaultView;
  if (!win) return "no_such_element";
  if (win.location.origin !== expectedOrigin) return "off_origin";
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return "invalid";
  }
  if (!element || !(element instanceof win.HTMLElement)) {
    return "no_such_element";
  }
  if (element instanceof win.HTMLFormElement) element.requestSubmit();
  else element.click();
  return "ok";
}

/**
 * A layout signature: the document's and viewport's size and every form
 * control's box. Two reads that differ were taken under different layouts,
 * which is what a frame's mask epoch has to notice.
 */
export function pfLayout(expectedOrigin: string): string {
  const win = document.defaultView;
  if (win && win.location.origin !== expectedOrigin)
    throw new Error("off_origin");
  const root = document.documentElement;
  const boxes: string[] = [];
  const controls = document.querySelectorAll("input,textarea,select,iframe");
  for (const control of Array.from(controls).slice(0, 200)) {
    const rect = control.getBoundingClientRect();
    boxes.push(
      [rect.left, rect.top, rect.width, rect.height]
        .map((n) => Math.round(n))
        .join(","),
    );
  }
  return [
    `${root.scrollWidth}x${root.scrollHeight}`,
    `${win?.innerWidth ?? 0}x${win?.innerHeight ?? 0}`,
    String(controls.length),
    boxes.join(";"),
  ].join("|");
}

/**
 * The page's markup with every value gone: scripts, styles and comments
 * removed, the value of every field blanked, and each node `strip` names
 * emptied. The live `value` property never reaches markup, and the attribute is
 * removed as well, so a value set either way is gone.
 */
export function pfReadDom(strip: string[], expectedOrigin: string): string {
  if (document.defaultView?.location.origin !== expectedOrigin) {
    throw new Error("off_origin");
  }
  // SAFETY: a deep clone of the document element is structurally an Element.
  const root = document.documentElement.cloneNode(true) as Element;
  for (const node of Array.from(
    root.querySelectorAll("script,style,noscript,template,link"),
  )) {
    node.remove();
  }
  const comments = document.createTreeWalker(root, 128);
  const found: Node[] = [];
  while (comments.nextNode()) found.push(comments.currentNode);
  for (const comment of found) comment.parentNode?.removeChild(comment);
  const keepsValue = [
    "button",
    "submit",
    "reset",
    "image",
    "checkbox",
    "radio",
  ];
  for (const field of Array.from(root.querySelectorAll("input,textarea"))) {
    const kind = (field.getAttribute("type") ?? "text").toLowerCase();
    if (field.tagName === "TEXTAREA") field.textContent = "";
    else if (!keepsValue.includes(kind)) field.removeAttribute("value");
  }
  for (const selector of strip) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const node of nodes) {
      node.removeAttribute("value");
      node.textContent = "";
    }
  }
  return root.outerHTML.slice(0, 200_000);
}

/**
 * Cover each selector's boxes with an opaque overlay, and count the selectors
 * that matched something. A selector that matched nothing is not counted:
 * the count is what the Host compares with what it asked to have covered.
 */
export function pfMask(selectors: string[], expectedOrigin: string): number {
  if (document.defaultView?.location.origin !== expectedOrigin) {
    throw new Error("off_origin");
  }
  let covered = 0;
  for (const selector of selectors) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (nodes.length === 0) continue;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const cover = document.createElement("div");
      cover.setAttribute("data-opensesame-mask", "");
      cover.setAttribute(
        "style",
        [
          "position:fixed",
          `left:${rect.left}px`,
          `top:${rect.top}px`,
          `width:${rect.width}px`,
          `height:${rect.height}px`,
          "background:#000",
          "z-index:2147483647",
          "pointer-events:none",
        ].join(";"),
      );
      document.documentElement.appendChild(cover);
    }
    covered += 1;
  }
  return covered;
}

/** Take the overlays down. */
export function pfUnmask(expectedOrigin: string): number {
  if (document.defaultView?.location.origin !== expectedOrigin) {
    throw new Error("off_origin");
  }
  const covers = Array.from(
    document.querySelectorAll("[data-opensesame-mask]"),
  );
  for (const cover of covers) cover.remove();
  return covers.length;
}
