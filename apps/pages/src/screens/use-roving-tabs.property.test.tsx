/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { useRovingTabs } from "./use-roving-tabs.js";

type Key = "ArrowLeft" | "ArrowRight" | "Home" | "End" | "x" | "Escape";
type Operation = { kind: "focus"; at: number } | { kind: "key"; key: Key };
type Coverage = {
  left: number;
  right: number;
  home: number;
  end: number;
  other: number;
  focus: number;
  wrap: number;
};
const category = {
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  x: "other",
  Escape: "other",
} satisfies Record<Key, keyof Coverage>;

function Tabs({ count, initial }: { count: number; initial: number }) {
  const [selected, select] = useState(initial);
  const { tabProps } = useRovingTabs({ count, index: selected, select });
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  return (
    <div role="tablist" aria-label="Example tabs">
      {names.slice(0, count).map((name, index) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={selected === index}
          {...tabProps(index)}
        >
          {`Tab ${index + 1}`}
        </button>
      ))}
    </div>
  );
}

function expectedKey(key: Key, focus: number, count: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return focus === 0 ? count - 1 : focus - 1;
    case "ArrowRight":
      return focus === count - 1 ? 0 : focus + 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function press(
  tabs: HTMLElement[],
  key: Key,
  focus: number,
  coverage: Coverage,
): number | null {
  const next = expectedKey(key, focus, tabs.length);
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  fireEvent(tabs[focus], event);
  expect(event.defaultPrevented).toBe(next !== null);
  coverage[category[key]]++;
  if (
    tabs.length > 1 &&
    ((key === "ArrowLeft" && focus === 0) ||
      (key === "ArrowRight" && focus === tabs.length - 1))
  )
    coverage.wrap++;
  return next;
}

function exercise(
  count: number,
  start: number,
  operations: Operation[],
  coverage: Coverage,
) {
  const initial = start % count;
  render(<Tabs count={count} initial={initial} />);
  let selected = initial;
  let focus = initial;
  try {
    const tabs = screen.getAllByRole("tab");
    tabs[focus].focus();
    for (const operation of operations) {
      if (operation.kind === "focus") {
        focus = operation.at % count;
        tabs[focus].focus();
        coverage.focus++;
      } else {
        const next = press(tabs, operation.key, focus, coverage);
        if (next !== null) {
          selected = next;
          focus = next;
        }
      }
      expect(document.activeElement).toBe(tabs[focus]);
      expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([
        tabs[selected],
      ]);
      expect(
        tabs.filter((tab) => tab.getAttribute("aria-selected") === "true"),
      ).toEqual([tabs[selected]]);
    }
  } finally {
    cleanup();
  }
}

afterEach(cleanup);

it("keeps a single tab stop and follows generated keyboard and focus sequences", () => {
  const coverage = {
    left: 0,
    right: 0,
    home: 0,
    end: 0,
    other: 0,
    focus: 0,
    wrap: 0,
  };
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 6 }),
      fc.nat({ max: 40 }),
      fc.array(
        fc.oneof(
          fc.record({
            kind: fc.constant("focus" as const),
            at: fc.nat({ max: 40 }),
          }),
          fc.record({
            kind: fc.constant("key" as const),
            key: fc.constantFrom<Key>(
              "ArrowLeft",
              "ArrowRight",
              "Home",
              "End",
              "x",
              "Escape",
            ),
          }),
        ),
        { minLength: 1, maxLength: 30 },
      ),
      (count, start, operations: Operation[]) =>
        exercise(count, start, operations, coverage),
    ),
    { seed: 20261117, numRuns: 120 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});
