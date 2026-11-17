/** @vitest-environment jsdom */
import * as identity from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { testLockManager } from "../test-support/lock-manager.js";
import { IdentitySection } from "./IdentitySection.js";
import { contributeIdentityViews } from "./identity/identity-views.js";

afterEach(() => {
  cleanup();
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows local people without contacting a configured hosted directory when that capability is off", async () => {
  vi.stubGlobal("navigator", { locks: testLockManager });
  vi.spyOn(identity, "isRemoteIdentityConfigured").mockReturnValue(true);
  const fetch = vi.spyOn(globalThis, "fetch");
  const removeViews = contributeIdentityViews(["people"]);
  try {
    await vaultStore.create("local directory test password");
    render(
      <MemoryRouter initialEntries={["/identity?view=people"]}>
        <IdentitySection />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("button", { name: "New person" }),
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    removeViews();
  }
});
