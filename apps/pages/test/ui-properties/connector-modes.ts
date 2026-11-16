import { always } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  getFingerprint,
} from "@antithesishq/bombadil/browser";

// Only interact with this local fixture's controls. Never wander into the app
// or exercise live connector operations and credentials during exploration.
const state = extract(({ document }) => {
  const group = document.querySelector('[role="radiogroup"]');
  const choices = Array.from(group?.querySelectorAll('[role="radio"]') ?? []);
  const value = document.querySelector(
    '[data-testid="selection"]',
  )?.textContent;
  const violation = document.querySelector(
    '[data-testid="violation"]',
  )?.textContent;
  const controls = Array.from(
    document.querySelectorAll('[role="radio"], main > button'),
  );
  return {
    named: group?.getAttribute("aria-label") === "Connection method",
    choices: choices.length,
    selected: choices
      .filter((choice) => choice.getAttribute("aria-checked") === "true")
      .map((choice) => choice.textContent?.trim() ?? ""),
    value: value ?? "",
    violation: violation ?? "",
    targets: controls.flatMap((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? [
            {
              fingerprint: getFingerprint(control),
              point: {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
              },
            },
          ]
        : [];
    }),
  };
});

export const named_group_has_one_matching_selection = always(() => {
  const current = state.current;
  const label =
    current.value === "app" ? "GitHub App" : "Personal access token";
  return (
    current.named &&
    current.choices === 3 &&
    current.selected.length === 1 &&
    current.selected[0] === label &&
    ["app", "token"].includes(current.value ?? "")
  );
});

export const locked_or_unavailable_choices_never_change = always(
  () => state.current.violation === "false",
);

export const click_chooser_controls = actions(() =>
  state.current.targets.map((target) => ({ Click: target })),
);
