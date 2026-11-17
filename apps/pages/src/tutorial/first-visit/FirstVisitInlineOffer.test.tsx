/** @vitest-environment jsdom */
import * as targets from "@opensesame/app-core/tutorial/registry/targets.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FirstVisitInlineOffer } from "./FirstVisitInlineOffer.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("returns focus to the actual gate control after an offer is dismissed", async () => {
  const target = document.createElement("button");
  const host = document.createElement("div");
  host.dataset.firstVisitReturn = "unlock.setup";
  document.body.append(target, host);
  vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(target);
  const dismiss = vi.fn();
  render(
    <FirstVisitInlineOffer
      offer={{
        host,
        route: "/unlock/door",
        title: "Front door",
        steps: 2,
        start: vi.fn(),
        dismiss,
      }}
      body="A short walkthrough."
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(target);
});

it("returns focus to the prior control when an offer has no specific target", async () => {
  const target = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(target, host);
  target.focus();
  render(
    <FirstVisitInlineOffer
      offer={{
        host,
        route: "/vault",
        title: "Vault",
        steps: 2,
        start: vi.fn(),
        dismiss: vi.fn(),
      }}
      body="A short walkthrough."
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(document.activeElement).toBe(target);
});

it("returns focus to the prior control if the named target has gone away", async () => {
  const prior = document.createElement("button");
  const host = document.createElement("div");
  host.dataset.firstVisitReturn = "setup.finish";
  document.body.append(prior, host);
  prior.focus();
  vi.spyOn(targets, "resolveGuideTargetElement").mockReturnValue(null);
  render(
    <FirstVisitInlineOffer
      offer={{
        host,
        route: "/setup",
        title: "Setup",
        steps: 2,
        start: vi.fn(),
        dismiss: vi.fn(),
      }}
      body="A short walkthrough."
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(document.activeElement).toBe(prior);
});
