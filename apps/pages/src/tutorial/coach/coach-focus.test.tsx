/** @vitest-environment jsdom */

import * as targets from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { type ReactElement, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCoachFocus, useFirstVaultPinStep } from "./use-coach-behavior.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["unlock.seal-pin-entry", "unlock.seal-pin-confirm"] as const)(
  "blocks only the first-vault %s step until its field is ready",
  async (target) => {
    const input = document.createElement("input");
    input.setAttribute("data-guide-pin-ready", "false");
    document.body.append(input);
    const detach = targets.mountGuideTarget(target, input);
    const tour: GuideTourView = {
      kind: "point",
      target,
      step: 1,
      count: 2,
      message: "Enter a PIN.",
      side: null,
      action: false,
      degraded: false,
      canBack: true,
    };
    const { result, rerender, unmount } = renderHook(
      ({ firstVault }) => useFirstVaultPinStep(tour, firstVault),
      { initialProps: { firstVault: true } },
    );
    expect(result.current.action).toBe(true);
    input.setAttribute("data-guide-pin-ready", "true");
    await waitFor(() => expect(result.current.action).toBe(false));
    input.setAttribute("data-guide-pin-ready", "false");
    await waitFor(() => expect(result.current.action).toBe(true));
    rerender({ firstVault: false });
    expect(result.current.action).toBe(false);
    unmount();
    detach();
    input.remove();
  },
);

function Card({ actionOnly = false }: { actionOnly?: boolean }): ReactElement {
  const card = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useCoachFocus(true, "1:step:1", card, primary, actionOnly);
  return (
    <section ref={card}>
      {/* The exit key is found by its data attribute, as the real Head's
          key renders it — copy never decides where focus lands. */}
      <button type="button" aria-label="Exit tutorial" data-coach-exit="" />
      <button type="button" ref={primary}>
        Next
      </button>
    </section>
  );
}

function outside<K extends "input" | "button">(
  tag: K,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  document.body.appendChild(element);
  element.focus();
  return element;
}

describe("the card's first move of focus", () => {
  it("focuses Exit when a compact action step hides Next", () => {
    const { getByRole } = render(<Card actionOnly />);
    expect(document.activeElement).toBe(
      getByRole("button", { name: "Exit tutorial" }),
    );
  });

  it("takes it from the page body", () => {
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
  });

  it("takes it from the launcher that started the tour", () => {
    const launcher = outside("button");
    launcher.className = "support-launch";
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    launcher.remove();
  });

  it("takes it from a non-text control, as a person-started tour does", () => {
    const row = outside("button");
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    row.remove();
  });

  it("leaves it with someone typing in the page", () => {
    const field = outside("input");
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(field);
    expect(document.activeElement).not.toBe(
      getByRole("button", { name: "Next" }),
    );
    field.remove();
  });

  it("takes it from the Support panel's own field", () => {
    const panel = document.createElement("section");
    panel.setAttribute("aria-label", "Support");
    const field = document.createElement("input");
    panel.appendChild(field);
    document.body.appendChild(panel);
    field.focus();
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    panel.remove();
  });
});

describe("returning focus when the tutorial closes", () => {
  it("returns to Support when focus started on the body", () => {
    const launcher = outside("button");
    launcher.blur();
    vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(launcher);
    expect(document.activeElement).toBe(document.body);
    const { unmount } = render(<Card />);
    unmount();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it("returns to Support when the original control is removed", () => {
    const launcher = outside("button");
    const trigger = outside("button");
    vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(launcher);
    const { unmount } = render(<Card />);
    trigger.remove();
    unmount();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it("returns to Support when the original control can no longer be focused", () => {
    const launcher = outside("button");
    const trigger = outside("button");
    vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(launcher);
    const { unmount } = render(<Card />);
    trigger.disabled = true;
    unmount();
    expect(document.activeElement).toBe(launcher);
    trigger.remove();
    launcher.remove();
  });

  it("returns to Support when the original control is hidden", () => {
    const launcher = outside("button");
    const trigger = outside("button");
    vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(launcher);
    const { unmount } = render(<Card />);
    trigger.style.opacity = "0";
    unmount();
    expect(document.activeElement).toBe(launcher);
    trigger.remove();
    launcher.remove();
  });

  it("returns to the original control when it is still usable", () => {
    const launcher = outside("button");
    const trigger = outside("button");
    const focus = vi.spyOn(trigger, "focus");
    vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(launcher);
    const { unmount } = render(<Card />);
    unmount();
    expect(document.activeElement).toBe(trigger);
    expect(focus).toHaveBeenCalledWith();
    trigger.remove();
    launcher.remove();
  });
});
