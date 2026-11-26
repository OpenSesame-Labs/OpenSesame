/** @vitest-environment jsdom */

/**
 * The tutorial card, driven through the real panel.
 *
 * `placement.test.ts` proves where it sits and the runtime suite proves how a
 * tour is paced. This proves what is on the card at each step: Back and Next
 * (Replay and Done on the closing card), the "your move" cue, the segmented
 * meter, and what happens to a step whose control is not on screen.
 */

import {
  FIRST_VAULT_PIN_STEPS,
  FIRST_VAULT_SHELL_GUIDE,
  firstVaultGateGuide,
  firstVaultSignInGuide,
} from "@opensesame/app-core/tutorial/registry/first-vault-guide.js";
import { guideGoalIds } from "@opensesame/app-core/tutorial/registry/goals.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import { mergedGuideRoutes } from "@opensesame/app-core/tutorial/registry/routes.js";
import { guidePredicateIds } from "@opensesame/app-core/tutorial/registry/state.js";
import { guideTargetIds } from "@opensesame/app-core/tutorial/registry/targets.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { planGuideSteps } from "@opensesame/guide-runtime";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  disposeSupport,
  mountSupport,
  openPanel,
  tutorialCard,
  walkthrough,
} from "../__tests__/a11y/harness.js";
import {
  coachMessage,
  firstVaultTourProgress,
  sealTourProgress,
} from "./CoachParts.js";

afterEach(disposeSupport);

it("tells an already-mounted PIN road how to leave the held wait", () => {
  // SAFETY: this fixture satisfies GuideTourView for coachMessage; it only branches on step/kind/action/degraded.
  const tour = {
    step: 4,
    count: 8,
    kind: "point",
    message: "Seal with passkey.",
    target: "unlock.seal-actions",
    side: "bottom",
    action: false,
    degraded: false,
    canBack: true,
  } as GuideTourView;
  expect(coachMessage(tour, true, true, "")).toBe(
    "PIN is selected. Select Next.",
  );
});

async function startLock(targets: readonly string[] = ["shell.lock"]) {
  const user = userEvent.setup();
  const harness = mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    // SAFETY: fixture constructed in this test matches the declared contract.
    targets: [...targets] as never,
  });
  // jsdom has no layout: give the control a box, or there is nothing to light.
  for (const id of targets) {
    // SAFETY: fixture constructed in this test matches the declared contract.
    harness.fixtures.element(id as never).getBoundingClientRect = () =>
      ({
        left: 20,
        top: 20,
        right: 52,
        bottom: 52,
        width: 32,
        height: 32,
        x: 20,
        y: 20,
        toJSON() {},
      }) as DOMRect;
  }
  await openPanel(user);
  await user.click(walkthrough("Lock the vault"));
  return { user, harness, card: await tutorialCard() };
}

const counter = (card: HTMLElement) =>
  card.querySelector(".coach__count")?.textContent ?? "";

describe("the tutorial card", () => {
  // The meter's fixed lengths must move with the authored walks: a guide
  // edit that adds or drops a step changes the planner's stepCount, and this
  // test then fails until the meter constants in CoachParts are re-aligned.
  beforeAll(() => {
    // The authored guides wait on registry state; compiling them for the
    // length checks below needs the predicate vocabulary declared.
    registerGuidePredicates();
  });

  function plannedSteps(source: string): number {
    const compiled = compileGuide(
      source,
      {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: mergedGuideRoutes().map((route) => route.id),
        predicates: guidePredicateIds(),
      },
      AUTHORED_GUIDE_LIMITS,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return -1;
    return planGuideSteps(compiled.program).stepCount;
  }

  it("keeps passkey and PIN first-vault progress contiguous", () => {
    expect(firstVaultTourProgress("unlock.methods", 8, 8)).toEqual({
      offset: 0,
      count: 12,
    });
    expect(firstVaultTourProgress("unlock.seal-actions", 8, 8)).toEqual({
      offset: 0,
      count: 12,
    });
    expect(firstVaultTourProgress("unlock.seal-pin-entry", 8, 8)).toEqual({
      offset: 0,
      count: 16,
    });
    expect(firstVaultTourProgress("unlock.seal-actions", 8, 8, true)).toEqual({
      offset: 0,
      count: 16,
    });
    expect(firstVaultTourProgress(null, 8, 4)).toEqual({
      offset: 4,
      count: 12,
    });
    expect(firstVaultTourProgress(null, 8, 8)).toEqual({
      offset: 8,
      count: 16,
    });
  });

  it("counts the optional PIN steps in the standalone passkey guide", () => {
    const tour: Pick<GuideTourView, "target" | "count"> = {
      target: "unlock.seal-actions",
      count: 7,
    };
    expect(sealTourProgress(tour, "gate.unlock.passkey", 0, false).count).toBe(
      3,
    );
    expect(sealTourProgress(tour, "gate.unlock.passkey", 0, true).count).toBe(
      7,
    );
    expect(
      sealTourProgress({ ...tour, count: 3 }, "gate.unlock.passkey", 0, false)
        .count,
    ).toBe(3);
  });

  it("pins the meter's gate and shell lengths to the authored walks", () => {
    // No WebAuthn host in this environment, so the door's own walk is the
    // PIN road: two setup steps, the road to the seal decision, then the
    // four PIN seal fields. The passkey road is the same walk without them,
    // and the shell continuation is the eight-step password walk.
    expect(plannedSteps(firstVaultGateGuide())).toBe(8);
    expect(plannedSteps(firstVaultSignInGuide())).toBe(6);
    expect(FIRST_VAULT_PIN_STEPS.length).toBe(4);
    expect(plannedSteps(FIRST_VAULT_SHELL_GUIDE)).toBe(8);
  });

  it("has Next on every step and Done on the closing card", async () => {
    const { user, card } = await startLock();
    expect(counter(card)).toBe("Step 1 of 2");
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 2 of 2"));
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Complete"));
    expect(within(card).getByRole("button", { name: /^Done/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^Replay/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /^Next/ })).toBeNull();
  });

  it("goes Back, and Back is not offered on the first step", async () => {
    const { user, card } = await startLock();
    const back = () =>
      within(card).getByRole<HTMLButtonElement>("button", { name: /^Back/ });
    expect(back().disabled).toBe(true);

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 2 of 2"));
    expect(back().disabled).toBe(false);
    await user.click(back());
    await waitFor(() => expect(counter(card)).toBe("Step 1 of 2"));
  });

  it("replays from the closing card and finishes with Done", async () => {
    const { user, card } = await startLock();
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Complete"));

    await user.click(within(card).getByRole("button", { name: /^Replay/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 1 of 2"));

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Done/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Tutorial:/ })).toBeNull(),
    );
  });

  it("fills one meter segment per step, the current one marked", async () => {
    const { user, card } = await startLock();
    const segments = () =>
      [...card.querySelectorAll(".coach__seg")].map((node) =>
        node.className.replace("coach__seg coach__seg--", ""),
      );
    expect(segments()).toEqual(["now", "ahead"]);
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(segments()).toEqual(["done", "now"]));
  });

  it("says it is the person's move on a step that waits for them", async () => {
    const { user, card } = await startLock();
    expect(card.querySelector(".coach__cue")?.textContent).toBe("");
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(card.querySelector(".coach__cue")?.textContent).toContain(
        "Complete this step",
      ),
    );
  });

  it("says so, and still has Next, when the control it points at is not on screen", async () => {
    // No fixture is bound for the lock, so the step has nothing to light.
    const { user, card } = await startLock([]);
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(card.textContent).toContain("not on screen"));
    expect(document.querySelector(".coach__ring")).toBeNull();
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();
  });

  it("writes the sentence as text, whatever it contains", async () => {
    const { card } = await startLock();
    // The authored sentence remains text, separate from the counter and status.
    const text = card.querySelector(".coach__message");
    expect(text?.querySelectorAll("*").length).toBe(0);
    expect(text?.textContent).toContain("Lock the vault to remove its keys");
  });

  it("marks its root with the step's target and whether it degraded", async () => {
    const { user, card } = await startLock();
    const root = () => card.closest(".coach");
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 2 of 2"));
    await waitFor(() =>
      expect(root()?.getAttribute("data-coach-target")).toBe("shell.lock"),
    );
    // The control's box arrives on the next frame, so the mark settles then.
    await waitFor(() =>
      expect(root()?.getAttribute("data-coach-degraded")).toBe("false"),
    );
  });

  it("says degraded on a step whose control is not on screen", async () => {
    const { user, card } = await startLock([]);
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(card.closest(".coach")?.getAttribute("data-coach-degraded")).toBe(
        "true",
      ),
    );
    expect(card.closest(".coach")?.getAttribute("data-coach-target")).toBe(
      "shell.lock",
    );
  });

  it("has an empty target on a step that points at nothing", async () => {
    const { card } = await startLock();
    expect(card.closest(".coach")?.getAttribute("data-coach-target")).toBe("");
  });
});
