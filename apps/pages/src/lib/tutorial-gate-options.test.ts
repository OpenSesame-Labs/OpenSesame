import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import * as identity from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { describe, expect, it, vi } from "vitest";
import { buildTutorialGateOptions } from "./tutorial-gate-options.js";

describe("buildTutorialGateOptions", () => {
  it("defaults identityApi from isRemoteIdentityConfigured", () => {
    const identitySpy = vi
      .spyOn(identity, "isRemoteIdentityConfigured")
      .mockReturnValue(false);
    // SAFETY: test fixture — `buildTutorialGateOptions` only reads `plan.capabilities`.
    vi.spyOn(compositionStore, "getSnapshot").mockReturnValue({
      plan: { capabilities: {} },
    } as ReturnType<typeof compositionStore.getSnapshot>);
    // SAFETY: test fixture — gate reads vault status for connector tile roads only.
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "locked",
      guest: false,
      tomb: null,
    } as ReturnType<typeof vaultStore.getSnapshot>);
    buildTutorialGateOptions();
    expect(identitySpy).toHaveBeenCalled();
    identitySpy.mockRestore();
  });
});
