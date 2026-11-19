/** DOM helpers serialized with the tutorial measurement into the page. */
export function measurementTools(readableInstruction, measureButton) {
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
  const button = (node) => measureButton(node, box, pointable);
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

  return {
    box,
    button,
    pointable,
    viewport,
    visiblePart,
    probeControl,
    readableInstruction,
  };
}

/** Runs in the browser with the measurement's geometry and visibility helpers. */
export function measureButton(node, box, pointable) {
  const bounds = box(node);
  const hit = bounds
    ? document.elementFromPoint(
        (bounds.left + bounds.right) / 2,
        (bounds.top + bounds.bottom) / 2,
      )
    : null;
  return {
    box: bounds,
    reachable: Boolean(node && hit && node.contains(hit)),
    disabled: node ? node.disabled : null,
    ariaDisabled: node?.getAttribute("aria-disabled") === "true",
    visible: node ? pointable(node) : false,
  };
}

/** Check that the tutorial instruction can be read or scrolled. */
export function readableInstruction(prose) {
  if (!prose) return false;
  const style = getComputedStyle(prose);
  const minimum = Math.min(
    prose.scrollHeight,
    2 * Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom),
  );
  return prose.clientHeight + 1 >= minimum;
}

/** Measure the zoomed card and its touch controls in the browser. */
export function measureZoomedKeyboard(id) {
  const v = visualViewport;
  const field = document.querySelector(`[data-guide-targets~="${id}"]`);
  const card = document.querySelector(".coach__card");
  const text = card.querySelector(".coach__text");
  const controls = [
    card.querySelector('[aria-label="Exit tutorial"]'),
    card.querySelector(".coach__btn--back"),
    card.querySelector(".coach__btn--go"),
  ];
  const a = card.getBoundingClientRect();
  const b = field.getBoundingClientRect();
  const scrollCard = card.classList.contains("coach__card--short-scroll");
  const textBox = text.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(text).lineHeight);
  const next = controls[2].getBoundingClientRect();
  const back = controls[1].getBoundingClientRect();
  text.scrollTop = text.scrollHeight;
  return {
    geometry: {
      viewport: {
        width: v.width,
        height: v.height,
        scale: v.scale,
        left: v.offsetLeft,
        top: v.offsetTop,
      },
      card: { width: a.width, height: a.height, left: a.left, top: a.top },
      field: { width: b.width, height: b.height },
      text: {
        height: text.clientHeight,
        lineHeight: getComputedStyle(text).lineHeight,
      },
      controls: controls.map((control) => {
        const box = control.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          left: box.left - a.left,
          top: box.top - a.top,
          disabled: control.disabled,
        };
      }),
    },
    clear: a.bottom <= b.top || a.top >= b.bottom,
    inside:
      a.left >= v.offsetLeft &&
      a.right <= v.offsetLeft + v.width &&
      a.top >= v.offsetTop &&
      a.bottom <= v.offsetTop + v.height,
    readable: scrollCard
      ? text.clientHeight >= line &&
        textBox.bottom <= a.top + 1 &&
        card.scrollTop > 0 &&
        card.scrollTop + card.clientHeight >= card.scrollHeight - 1
      : text.clientHeight + 1 >= line &&
        text.scrollTop + text.clientHeight >= text.scrollHeight - 1,
    controls: controls.every((control, index) => {
      const box = control.getBoundingClientRect();
      if (
        index === 1 &&
        control.disabled &&
        getComputedStyle(control).display === "none"
      )
        return true;
      return (
        box.width >= 44 &&
        box.height >= 44 &&
        box.left >= a.left &&
        box.right <= a.right &&
        box.top >= a.top &&
        box.bottom <= a.bottom &&
        control.contains(
          document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          ),
        )
      );
    }),
    point: {
      x: next.left + next.width / 2 - v.offsetLeft,
      y: next.top + next.height / 2 - v.offsetTop,
    },
    backPoint: {
      x: back.left + back.width / 2 - v.offsetLeft,
      y: back.top + back.height / 2 - v.offsetTop,
    },
  };
}

/** Measure the visible controls on the zoomed completion card. */
export function measureZoomedCompletion() {
  const v = visualViewport;
  const card = document.querySelector(".coach__card");
  const bounds = card.getBoundingClientRect();
  const controls = [
    card.querySelector('[aria-label="Exit tutorial"]'),
    ...card.querySelectorAll(".coach__keys button"),
  ];
  const allFit =
    controls.length === 3 &&
    controls.every((control) => {
      const box = control.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return (
        box.width >= 44 &&
        box.height >= 44 &&
        box.left >= bounds.left &&
        box.right <= bounds.right &&
        box.top >= bounds.top &&
        box.bottom <= bounds.bottom &&
        control.contains(hit)
      );
    });
  const done = controls[2].getBoundingClientRect();
  return {
    allFit,
    point: {
      x: done.left + done.width / 2 - v.offsetLeft,
      y: done.top + done.height / 2 - v.offsetTop,
    },
  };
}

export function keyboardGeometry(page, target) {
  return page.evaluate((targetId) => {
    const card = document.querySelector(".coach__card");
    const field = document.querySelector(`[data-guide-targets~="${targetId}"]`);
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box && { top: box.top, bottom: box.bottom, height: box.height };
    };
    const bounds = field?.getBoundingClientRect();
    const hits = bounds
      ? document
          .elementsFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          )
          .map((node) => `${node.tagName}.${node.className}`)
          .slice(0, 12)
      : [];
    const ancestors = [];
    for (let node = field?.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        ancestors.push({
          className: node.className,
          overflow: style.overflowY,
          ...rect(node),
          clientHeight: node.clientHeight,
        });
      }
    }
    return {
      innerHeight: window.innerHeight,
      visualHeight: window.visualViewport?.height,
      visualTop: window.visualViewport?.offsetTop,
      card: rect(card),
      field: rect(field),
      cardClass: card?.className,
      maxHeight: card instanceof HTMLElement ? card.style.maxHeight : null,
      hits,
      ancestors,
    };
  }, target);
}
