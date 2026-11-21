/** @vitest-environment jsdom */
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  continueFirstVaultGuide,
  firstVaultGateSteps,
  firstVaultSignInPending,
  preserveFirstVaultGate,
  resetFirstVaultHandoff,
  takeFirstVaultGuide,
  useFirstVaultGateHandoff,
  useFirstVaultHandoff,
} from "./first-vault-handoff.js";
import type { SupportController } from "./session.js";
import { stubSupportController } from "./support-controller.test-support.js";

const signInGuide = {
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
} satisfies GuideRuntimeSnapshot;

afterEach(() => {
  cleanup();
  // Module state is shared across this file's tests; nothing may leak one
  // test's ceremony into the next.
  resetFirstVaultHandoff();
});

function SignInGate({ controller }: { controller: SupportController }) {
  useFirstVaultGateHandoff(controller, "/unlock/signin");
  return null;
}

it.each(["setup.default", "unlock.local-only"])(
  "resumes the sign-in step once when setup replaces the gate at %s",
  async (target) => {
    const oldController = stubSupportController("/unlock/signin", {
      guide: { ...signInGuide, tour: { ...signInGuide.tour, target } },
    }).support;
    const destroy = vi.spyOn(oldController, "destroy");
    preserveFirstVaultGate(oldController);
    expect(destroy).toHaveBeenCalledOnce();

    const next = stubSupportController("/unlock/signin");
    const startGuide = vi
      .spyOn(next.support, "startGuide")
      .mockImplementation(async () => {
        next.set({ guide: signInGuide });
      });
    render(
      <StrictMode>
        <SignInGate controller={next.support} />
      </StrictMode>,
    );
    await waitFor(() => expect(startGuide).toHaveBeenCalledOnce());
    expect(startGuide).toHaveBeenCalledWith(
      expect.stringContaining('focus "unlock.local-only"'),
      "authored",
    );
  },
);

it("keeps the sign-in handoff if setup replaces a gate before its engine loads", async () => {
  const original = stubSupportController("/unlock/signin", {
    guide: signInGuide,
  });
  preserveFirstVaultGate(original.support);

  const loading = stubSupportController("/unlock/signin");
  const next = stubSupportController("/unlock/signin");
  const rendered = render(<SignInGate controller={loading.support} />);
  await waitFor(() => expect(loading.started).toHaveLength(1));
  expect(firstVaultSignInPending("/unlock/signin")).toBe(true);
  preserveFirstVaultGate(loading.support);
  rendered.rerender(<SignInGate controller={next.support} />);
  await waitFor(() => expect(next.started).toHaveLength(1));
  act(() => next.set({ guide: signInGuide }));
  expect(firstVaultSignInPending("/unlock/signin")).toBe(false);

  const later = stubSupportController("/unlock/signin");
  rendered.rerender(<SignInGate controller={later.support} />);
  await act(async () => {});
  expect(later.started).toHaveLength(0);
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

it("scopes passkey progress to the resumed controller across StrictMode", async () => {
  const controller = stubSupportController("/vault");
  vi.spyOn(controller.support, "startGuide").mockResolvedValue();
  function Shell() {
    useFirstVaultHandoff(controller.support);
    return null;
  }
  continueFirstVaultGuide(4);
  render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
  await waitFor(() => expect(firstVaultGateSteps(controller.support)).toBe(4));
  expect(firstVaultGateSteps(stubSupportController("/vault").support)).toBe(8);

  act(() => controller.set({ guide: { ...signInGuide, status: "done" } }));
  expect(firstVaultGateSteps(controller.support)).toBe(8);

  continueFirstVaultGuide(4);
  await waitFor(() => expect(firstVaultGateSteps(controller.support)).toBe(4));
});

it("does not restart the gate tutorial after the vault has opened", async () => {
  const oldController = stubSupportController("/unlock/signin", {
    guide: signInGuide,
  }).support;
  preserveFirstVaultGate(oldController, true);
  const controller = stubSupportController("/unlock/signin").support;
  const startGuide = vi.spyOn(controller, "startGuide").mockResolvedValue();
  render(<SignInGate controller={controller} />);
  await act(async () => {});
  expect(startGuide).not.toHaveBeenCalled();
});
