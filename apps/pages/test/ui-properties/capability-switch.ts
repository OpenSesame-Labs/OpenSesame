import { always } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  getFingerprint,
} from "@antithesishq/bombadil/browser";

// The fixture's pointer-down oracle observes user intent independently of the
// controlled switch callback. Nothing here reaches real capabilities or vaults.
const state = extract(({ document }) => {
  const switches = document.querySelectorAll('[role="switch"]');
  const control = switches[0];
  const output = (name: string) =>
    document.querySelector(`[data-testid="${name}"]`)?.textContent ?? "";
  const controls = Array.from(
    document.querySelectorAll(
      '[role="switch"], [data-testid="permission"], [data-testid="availability"]',
    ),
  );
  return {
    switchCount: switches.length,
    named: control?.getAttribute("aria-label") === "Example capability",
    checked: control?.getAttribute("aria-checked") ?? "",
    expectedChecked: output("expected-checked"),
    actualRequests: output("actual-requests"),
    expectedRequests: output("expected-requests"),
    coverage: {
      accepted: Number(output("accepted-attempts")),
      rejected: Number(output("rejected-attempts")),
      disabled: Number(output("disabled-attempts")),
    },
    targets: controls.flatMap((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? [
            {
              fingerprint: getFingerprint(item),
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

export const switch_checked_matches_allowed_attempts = always(() => {
  const current = state.current;
  return (
    current.switchCount === 1 &&
    current.named &&
    ["true", "false"].includes(current.expectedChecked) &&
    current.checked === current.expectedChecked
  );
});

export const switch_requests_match_attempts = always(() => {
  const current = state.current;
  return (
    /^\d+$/.test(current.actualRequests) &&
    current.actualRequests === current.expectedRequests
  );
});

export const click_switch_controls = actions(() =>
  state.current.targets.map((target) => ({ Click: target })),
);
