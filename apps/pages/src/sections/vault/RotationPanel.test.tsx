import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { installPasswordResetVaultUi } from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";
import {
  clearRotationQueue,
  enqueueManualRotation,
  loadRotationEvents,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import * as rotationRelay from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { rotationSeams } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotationPanel } from "./RotationPanel.js";

installDoublePorts();

function snapshotApproving(approved: readonly string[]): CompositionSnapshot {
  const base = double.getSnapshot();
  if (base.plan === null) throw new Error("the double resolves a plan");
  return { ...base, plan: { ...base.plan, approvedCapabilities: approved } };
}

function renderPanel(item: VaultItem, scope = "personal") {
  return render(
    <MemoryRouter>
      <RotationPanel item={item} scope={scope} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearRotationQueue();
  clearNotices();
  const hidden = snapshotApproving([]);
  Object.assign(capabilityPorts, {
    compositionStore: {
      ...double,
      getSnapshot: () => hidden,
    },
  });
  vi.stubGlobal("LanguageModel", { availability: async () => "unavailable" });
});
afterEach(() => {
  cleanup();
  rotationSeams.relay = null;
  clearRotationQueue();
  vi.unstubAllGlobals();
});

function account() {
  const item = createItem("account", "Private mail");
  item.uris = [{ id: "u1", uri: "https://mail.example.test", match: "domain" }];
  return item;
}

describe("RotationPanel", () => {
  it("enables a thirty-day automatic schedule for an account", () => {
    renderPanel(account());
    expect(screen.getByText(/On · every 30 days/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Automatic rotation" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("prompts to configure password reset when the capability is off", async () => {
    renderPanel(account());
    await userEvent.click(
      screen.getByRole("button", { name: /Request password rotation/i }),
    );
    expect(loadRotationEvents()).toHaveLength(0);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Password reset");
    expect(notices[0]?.act?.label).toBe("Settings");
  });

  it("queues a manual rotation when configured and says out of sync without a relay", async () => {
    const ready = snapshotApproving(["ai.password-reset"]);
    Object.assign(capabilityPorts, {
      compositionStore: { ...double, getSnapshot: () => ready },
    });
    const restore = installPasswordResetVaultUi({
      subscribeRuns: () => () => undefined,
      runPhaseFor: () => null,
      evaluateReadiness: async () => ({ ok: true }),
    });
    try {
      renderPanel(account());
      await userEvent.click(
        screen.getByRole("button", { name: /Request password rotation/i }),
      );
      expect(loadRotationEvents()).toHaveLength(1);
      expect(await screen.findByText(/Out of sync/u)).toBeTruthy();
      expect(listNotices()).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("warns on a generator-backed type with no provider path", () => {
    renderPanel(createItem("card", "Test card"));
    expect(screen.getByText(/does not generate a new value/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Request rotation" }),
    ).toBeTruthy();
  });

  it("queues a manual request without changing the saved value", async () => {
    const item = createItem("secret", "Service secret");
    const original = structuredClone(item);
    renderPanel(item);
    await userEvent.click(
      screen.getByRole("button", { name: "Request rotation" }),
    );
    expect(await screen.findByText(/Out of sync/u)).toBeTruthy();
    expect(loadRotationEvents()).toHaveLength(1);
    expect(item).toEqual(original);
  });

  it("does not say a relay is missing when a configured relay rejects a request", async () => {
    rotationSeams.relay = async () => ({ ok: false, detail: "Not accepted" });
    renderPanel(createItem("card", "Test card"));
    await userEvent.click(
      screen.getByRole("button", { name: "Request rotation" }),
    );
    expect(
      await screen.findByText(
        "Out of sync — rotation is pending and may retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no relay is configured/iu)).toBeNull();
  });

  it("offers to add a website instead of requesting an unavailable rotation", () => {
    const item = createItem("account", "Private mail");
    renderPanel(item);
    expect(
      screen.getByText("Add an HTTPS website to enable automatic rotation."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Add website" }).getAttribute("href"),
    ).toBe(`/vault/${item.id}/edit`);
    expect(
      screen.queryByRole("button", { name: "Automatic rotation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request password rotation" }),
    ).toBeNull();
  });

  it("clears its failed request notice when the vault panel unmounts", async () => {
    const item = createItem("card", "Test card");
    const failQueue = vi
      .spyOn(rotationRelay, "processRotationQueue")
      .mockRejectedValueOnce(new Error("Test queue failure"));
    try {
      const panel = renderPanel(item);
      await userEvent.click(
        screen.getByRole("button", { name: "Request rotation" }),
      );
      expect(listNotices().map((notice) => notice.body)).toContain(
        "Rotation is queued and may retry. Its status could not be confirmed.",
      );
      expect(
        screen.getByRole("img", {
          name: "Rotation is queued and may retry. Its status could not be confirmed.",
        }),
      ).toBeTruthy();
      expect(loadRotationEvents()).toHaveLength(1);
      expect(screen.queryByText(/Rotation queued/u)).toBeNull();
      panel.unmount();
      expect(listNotices()).toHaveLength(0);
    } finally {
      failQueue.mockRestore();
    }
  });

  it("reports a request that failed before it was queued", async () => {
    const ready = snapshotApproving(["ai.password-reset"]);
    Object.assign(capabilityPorts, {
      compositionStore: { ...double, getSnapshot: () => ready },
    });
    const restore = installPasswordResetVaultUi({
      subscribeRuns: () => () => undefined,
      runPhaseFor: () => null,
      evaluateReadiness: async () => {
        throw new Error("Test readiness failure");
      },
    });
    try {
      renderPanel(account());
      await userEvent.click(
        screen.getByRole("button", { name: "Request password rotation" }),
      );
      expect(
        await screen.findByRole("img", {
          name: "Could not start rotation. Try again.",
        }),
      ).toBeTruthy();
      expect(loadRotationEvents()).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("distinguishes an earlier pending rotation from a failed new request", async () => {
    const item = account();
    enqueueManualRotation(item, "personal");
    const ready = snapshotApproving(["ai.password-reset"]);
    Object.assign(capabilityPorts, {
      compositionStore: { ...double, getSnapshot: () => ready },
    });
    const restore = installPasswordResetVaultUi({
      subscribeRuns: () => () => undefined,
      runPhaseFor: () => null,
      evaluateReadiness: async () => {
        throw new Error("Test readiness failure");
      },
    });
    try {
      renderPanel(item);
      await userEvent.click(
        screen.getByRole("button", { name: "Request password rotation" }),
      );
      expect(
        await screen.findByRole("img", {
          name: "Could not start this request. An earlier rotation is still pending.",
        }),
      ).toBeTruthy();
      expect(loadRotationEvents()).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("does not claim a rotation failed to start after its queue status is lost", async () => {
    const failAfterQueue = vi
      .spyOn(rotationRelay, "processRotationQueue")
      .mockImplementationOnce(async () => {
        clearRotationQueue();
        throw new Error("Test queue failure");
      });
    try {
      renderPanel(createItem("card", "Test card"));
      await userEvent.click(
        screen.getByRole("button", { name: "Request rotation" }),
      );
      expect(
        await screen.findByRole("img", {
          name: "Could not confirm the rotation status. Check before trying again.",
        }),
      ).toBeTruthy();
    } finally {
      failAfterQueue.mockRestore();
    }
  });

  it("draws nothing for a type without a generator", () => {
    renderPanel(createItem("note", "Memo"));
    expect(screen.queryByRole("heading", { name: "Rotation" })).toBeNull();
  });

  it("offers the editor instead of a rotation that cannot run in a guest vault", () => {
    const item = account();
    renderPanel(item, "");
    expect(
      screen
        .getByRole("link", { name: "Edit to generate" })
        .getAttribute("href"),
    ).toBe(`/vault/${item.id}/edit`);
    expect(
      screen.queryByRole("button", { name: "Request password rotation" }),
    ).toBeNull();
    expect(loadRotationEvents()).toHaveLength(0);
  });

  it("offers guest secrets for editing without labeling their values as test data", () => {
    const item = createItem("secret", "Service secret");
    renderPanel(item, "");
    expect(
      screen
        .getByRole("link", { name: "Edit to generate" })
        .getAttribute("href"),
    ).toBe(`/vault/${item.id}/edit`);
    expect(screen.queryByText(/test|synthetic/iu)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request password rotation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request rotation" }),
    ).toBeNull();
    expect(loadRotationEvents()).toHaveLength(0);
  });
});
