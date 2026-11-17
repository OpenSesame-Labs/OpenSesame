/** @vitest-environment jsdom */
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  continueFirstVaultGuide,
  preserveFirstVaultGate,
  takeFirstVaultGuide,
  useFirstVaultGateHandoff,
  useFirstVaultHandoff,
} from "./first-vault-handoff.js";
import { stubSupportController } from "./support-controller.test-support.js";

const signInGuide: GuideRuntimeSnapshot = {
  status: "running",
  goal: "gate.front-door",
  index: 0,
  total: 1,
  runId: 1,
  message: null,
  error: null,
  tour: {
    step: 1,
    count: 1,
    kind: "point",
    message: "Continue without an account.",
    target: "unlock.local-only",
    side: null,
    action: true,
    degraded: false,
    canBack: false,
  },
};

afterEach(() => {
  cleanup();
  takeFirstVaultGuide();
});

it("resumes the sign-in step once when setup replaces the gate", async () => {
  const oldController = stubSupportController("/unlock/signin", {
    guide: signInGuide,
  }).support;
  const destroy = vi.spyOn(oldController, "destroy");
  preserveFirstVaultGate(oldController);
  expect(destroy).toHaveBeenCalledOnce();

  const nextController = stubSupportController("/unlock/signin").support;
  const startGuide = vi.spyOn(nextController, "startGuide").mockResolvedValue();
  function Gate() {
    useFirstVaultGateHandoff(nextController, "/unlock/signin");
    return null;
  }
  render(
    <StrictMode>
      <Gate />
    </StrictMode>,
  );
  await waitFor(() => expect(startGuide).toHaveBeenCalledOnce());
  expect(startGuide).toHaveBeenCalledWith(
    expect.stringContaining('focus "unlock.local-only"'),
    "authored",
  );
});

it("resumes once after StrictMode remounts the shell effects", async () => {
  const controller = stubSupportController("/vault").support;
  const startGuide = vi.spyOn(controller, "startGuide").mockResolvedValue();
  function Shell() {
    useFirstVaultHandoff(controller);
    return null;
  }
  continueFirstVaultGuide();
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
  await waitFor(() => expect(startGuide).toHaveBeenCalledOnce());
  expect(startGuide).toHaveBeenCalledWith(expect.any(String), "authored");
  expect(takeFirstVaultGuide()).toBe(false);
});

it("does not restart the gate tutorial after the vault has opened", async () => {
  const oldController = stubSupportController("/unlock/signin", {
    guide: signInGuide,
  }).support;
  preserveFirstVaultGate(oldController, true);
  const controller = stubSupportController("/unlock/signin").support;
  const startGuide = vi.spyOn(controller, "startGuide").mockResolvedValue();
  function Gate() {
    useFirstVaultGateHandoff(controller, "/unlock/signin");
    return null;
  }
  render(<Gate />);
  await act(async () => {});
  expect(startGuide).not.toHaveBeenCalled();
});
