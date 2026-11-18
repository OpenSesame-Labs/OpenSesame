import { always } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  getFingerprint,
} from "@antithesishq/bombadil/browser";

const state = extract(({ document }) => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const expected = Number(
    document.querySelector('[data-testid="expected"]')?.textContent,
  );
  const output = (key: string) =>
    Number(document.querySelector(`[data-testid="count-${key}"]`)?.textContent);
  const active = document.activeElement;
  const focused = active ? tabs.indexOf(active) : -1;
  return {
    count: tabs.length,
    expected,
    selected: tabs.flatMap((tab, index) =>
      tab.getAttribute("aria-selected") === "true" ? [index] : [],
    ),
    stops: tabs.flatMap((tab, index) =>
      tab.getAttribute("tabindex") === "0" ? [index] : [],
    ),
    focused,
    coverage: {
      left: output("ArrowLeft"),
      right: output("ArrowRight"),
      home: output("Home"),
      end: output("End"),
    },
    targets: tabs.flatMap((tab) => {
      const rect = tab.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? [
            {
              fingerprint: getFingerprint(tab),
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

export const tabs_follow_intent = always(() => {
  const value = state.current;
  return (
    value.count === 4 &&
    value.selected.length === 1 &&
    value.stops.length === 1 &&
    value.selected[0] === value.expected &&
    value.stops[0] === value.expected &&
    (value.focused < 0 || value.focused === value.expected)
  );
});

export const explore_tabs = actions(() => [
  ...state.current.targets.map((target) => ({ Click: target })),
  { PressKey: { code: 37 } },
  { PressKey: { code: 39 } },
  { PressKey: { code: 36 } },
  { PressKey: { code: 35 } },
]);
