/**
 * What one tutorial step shows, measured in the page, and what every step owes.
 *
 * A step that points at a control is only a pass if the control the registry
 * names is lit, on screen, not covered by the card, and is what a pointer
 * actually reaches through the aperture. The control is found by its registry
 * target id (`data-guide-targets`, set where the registry binds it), never by
 * the ring the product drew: the ring is the claim, the control is the fact.
 */

/**
 * Runs in the page: everything one step shows. Small helpers, so the
 * measurement stays readable and each one is simple to trust.
 */
export function measureStep(tools) {
  const root = document.querySelector(".coach");
  if (!root) return null;
  const text = (selector) => root.querySelector(selector)?.textContent ?? "";
  const {
    box,
    button,
    pointable,
    viewport,
    visiblePart,
    probeControl,
    readableInstruction,
  } = tools();
  const target = root.getAttribute("data-coach-target") ?? "";
  const candidates = target
    ? [
        ...document.querySelectorAll(`[data-guide-targets~="${target}"]`),
      ].filter(pointable)
    : [];
  const control =
    candidates.find((candidate) => visiblePart(candidate, null)) ??
    candidates[0] ??
    null;
  const card = root.querySelector(".coach__card");
  const ring = root.querySelector(".coach__ring");
  const go = root.querySelector(".coach__btn--go");
  const exit = root.querySelector('button[aria-label="Exit tutorial"]');
  const back = [...root.querySelectorAll(".coach__btn")].find((b) =>
    /Back|Replay/.test(b.textContent ?? ""),
  );
  const ringBox = box(ring);
  const goInfo = button(go);
  const exitInfo = button(exit);

  return {
    kind: root.getAttribute("data-coach-kind"),
    step: Number(root.getAttribute("data-coach-step")),
    target,
    degraded: root.getAttribute("data-coach-degraded") === "true",
    counter: text(".coach__count"),
    title: text(".coach__title"),
    text: text(".coach__text"),
    textReadable: readableInstruction(root.querySelector(".coach__text")),
    cue: text(".coach__cue"),
    notOnScreen: text(".coach__cue").includes("not on screen"),
    action: Boolean(ring?.classList.contains("is-action")),
    actionOnly: Boolean(
      card?.classList.contains("coach__card--awaiting-action"),
    ),
    card: box(card),
    ring: ringBox,
    control: box(control),
    visibleControl: control ? visiblePart(control, null) : null,
    actionable:
      control?.matches(
        'button, a, input, select, textarea, [role="button"], [role="switch"]',
      ) ?? false,
    probe: control ? probeControl(control, ringBox) : null,
    go: goInfo.box,
    goReachable: goInfo.reachable,
    goDisabled: goInfo.disabled,
    goAriaDisabled: goInfo.ariaDisabled,
    goVisible: goInfo.visible,
    exit: exitInfo.box,
    exitVisible: exitInfo.visible,
    exitReachable: exitInfo.reachable,
    backDisabled: back ? back.disabled : null,
    focusInCard: Boolean(card?.contains(document.activeElement)),
    viewport,
  };
}

function intersects(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

const inside = (box, viewport) =>
  box.left >= -0.5 &&
  box.top >= -0.5 &&
  box.right <= viewport.width + 0.5 &&
  box.bottom <= viewport.height + 0.5;

const touches = (box, viewport) =>
  box.width > 0 &&
  box.height > 0 &&
  box.right > 0 &&
  box.bottom > 0 &&
  box.left < viewport.width &&
  box.top < viewport.height;

const describeBox = (box) =>
  `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;

function actionCardChecks(info, phone) {
  const { card, viewport } = info;
  return [
    [
      info.action && info.goAriaDisabled && !info.goVisible,
      "the action-only card waits for the highlighted control",
    ],
    [
      Boolean(info.exit) &&
        info.exitVisible &&
        info.exitReachable &&
        inside(info.exit, viewport) &&
        (!phone || info.exit.height >= 43.5),
      `Exit remains visible and reachable on the action-only card (${info.exit ? describeBox(info.exit) : "missing"}; card ${describeBox(card)}; reachable ${info.exitReachable})`,
    ],
  ];
}

function nextCardChecks(info, phone) {
  const { card, go, viewport } = info;
  const out = [
    [
      Boolean(go) && go.width > 0 && !info.goDisabled,
      "Next is present and enabled",
    ],
  ];
  if (!go) return out;
  out.push([inside(go, viewport), "Next is inside the viewport"]);
  out.push([
    go.left >= card.left - 0.5 &&
      go.right <= card.right + 0.5 &&
      go.top >= card.top - 0.5 &&
      go.bottom <= card.bottom + 0.5 &&
      info.goReachable,
    "Next is fully visible and reachable in the card",
  ]);
  if (phone) {
    out.push([
      go.height >= 43.5,
      `Next is a 44px key on a phone (${Math.round(go.height)}px)`,
    ]);
  }
  return out;
}

/** The card, and its available actions. */
function cardChecks(info, phone) {
  const { card, viewport } = info;
  return [
    [
      inside(card, viewport),
      `the card sits inside the viewport (${describeBox(card)} in ${viewport.width}x${viewport.height})`,
    ],
    [info.text.trim().length > 0, "the step says something"],
    [info.textReadable, "the instruction has room to read or scroll"],
    ...(info.actionOnly
      ? actionCardChecks(info, phone)
      : nextCardChecks(info, phone)),
  ];
}

/** What a pointer reaches at the visible centre of the control, as one check. */
function reachChecks(info) {
  const { probe, target } = info;
  if (probe === null) {
    return [[false, `the registry's control for ${target} is in the page`]];
  }
  if (!probe.visible) {
    return [
      [
        false,
        `the control for ${target} has a visible part inside the aperture`,
      ],
    ];
  }
  const where = `at ${probe.x},${probe.y} a pointer reaches ${probe.hit}`;
  const cause = probe.onCard ? " (the card)" : probe.onDim ? " (the dim)" : "";
  return [
    [
      probe.onControl,
      `the lit control is reachable through the aperture: ${where}${cause}, not ${target}`,
    ],
  ];
}

/** The lit control: there, visible, uncovered by the card, reachable. */
function litChecks(info) {
  const { card, ring, viewport } = info;
  const out = [
    [!info.notOnScreen, "the control the step points at is on screen"],
  ];
  if (info.notOnScreen) return out;
  out.push([Boolean(ring), "the lit control has an aperture around it"]);
  if (!ring) return out;
  out.push(
    [touches(ring, viewport), "the lit control is inside the viewport"],
    [!intersects(card, ring), "the card does not cover the lit control"],
    ...reachChecks(info),
  );
  if (info.actionable && info.visibleControl && info.control) {
    out.push(
      [
        !intersects(card, info.visibleControl),
        "the card does not cover the actual control",
      ],
      [
        info.visibleControl.width >= info.control.width - 1 &&
          info.visibleControl.height >= info.control.height - 1,
        "the actual control is fully visible inside its scrollports",
      ],
    );
  }
  return out;
}

/** The checks every step owes, as [ok, what] pairs. */
export function stepChecks(info, { phone }) {
  if (!info.card) return [[false, "the card is on screen"]];
  const out = [[true, "the card is on screen"], ...cardChecks(info, phone)];
  if (info.kind === "point" && info.target !== "") out.push(...litChecks(info));
  return out;
}

/** Build the standard measured tutorial step assertion for a browser walk. */
export function tutorialStepChecker(
  page,
  check,
  phone,
  total,
  label,
  readStep,
  { out, width, keepShots } = {},
) {
  return async function step(target, number, expectedTotal = total) {
    await page
      .locator(
        `.coach[data-coach-target="${target}"][data-coach-status="waiting"]`,
      )
      .waitFor({ timeout: 30000 });
    const info = await readStep(page);
    check(info?.target === target, `${label}: target ${target}`);
    check(
      info?.counter === `Step ${number} of ${expectedTotal}`,
      `${label}: progress Step ${number} of ${expectedTotal}`,
    );
    if (info) {
      for (const [ok, what] of stepChecks(info, { phone }))
        check(ok, `${label} · ${target}: ${what}`);
    }
    if (keepShots)
      await page.screenshot({
        path: `${out}/${width}-${label.replaceAll(" ", "-")}-${String(number).padStart(2, "0")}.png`,
      });
    return info;
  };
}

/** Assert a required control is in the viewport and wins its center hit test. */
export async function checkControlReachable(page, check, control, label) {
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  const hit =
    box &&
    (await control.evaluate(
      (node, point) => {
        const top = document.elementFromPoint(point.x, point.y);
        return top !== null && (node === top || node.contains(top));
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ));
  check(
    box !== null &&
      box.y >= 0 &&
      box.y + box.height <= viewport.height &&
      hit === true,
    `first vault: ${label} is visible and reachable`,
  );
}

/** Prove the method decision cannot advance before a usable PIN field exists. */
export async function checkTutorialNextBlocked(page, check, next) {
  const visible = await next.isVisible();
  check(
    !visible || (await next.getAttribute("aria-disabled")) === "true",
    "first vault: Next cannot skip an available passkey decision",
  );
  if (!visible) return;
  await next.evaluate((button) => button.click());
  check(
    (await page
      .locator('.coach[data-coach-target="unlock.seal-actions"]')
      .count()) === 1,
    "first vault: disabled Next keeps the seal decision active",
  );
}

/** Wait for PRF failure to select the cross-platform road, with useful state. */
export async function waitForSecurityKey(
  page,
  { out, width, label, keepShots },
) {
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="tab"]')].some(
          (tab) =>
            tab.textContent?.trim() === "Security key" &&
            tab.getAttribute("aria-selected") === "true",
        ),
      undefined,
      { timeout: 15000 },
    );
  } catch (error) {
    if (keepShots)
      await page.screenshot({
        path: `${out}/${width}-${label.replaceAll(" ", "-")}-security-key-timeout.png`,
        fullPage: true,
      });
    const state = await page.evaluate(() => ({
      url: location.href,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
        text: tab.textContent?.trim(),
        selected: tab.getAttribute("aria-selected"),
      })),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim(),
    }));
    throw new Error(
      `Security key fallback did not appear: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/** Explain a stuck transition from the method group to the first PIN field. */
export async function waitForPinTutorial(
  page,
  { out, width, label, keepShots },
) {
  try {
    await page
      .locator('.coach[data-coach-target="unlock.seal-pin-entry"]')
      .waitFor();
  } catch (error) {
    if (keepShots)
      await page.screenshot({
        path: `${out}/${width}-${label.replaceAll(" ", "-")}-pin-transition-timeout.png`,
        fullPage: true,
      });
    const state = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
        text: tab.textContent?.trim(),
        selected: tab.getAttribute("aria-selected"),
      })),
      targets: [...document.querySelectorAll("[data-guide-targets]")].map(
        (target) => target.getAttribute("data-guide-targets"),
      ),
      coach: document
        .querySelector(".coach")
        ?.getAttribute("data-coach-target"),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim(),
    }));
    throw new Error(`PIN tutorial did not advance: ${JSON.stringify(state)}`, {
      cause: error,
    });
  }
}
