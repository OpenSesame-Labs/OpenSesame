import * as identity from "@opensesame/app-core/lib/identity.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../sections/settings/provider-tile-items.js", () => ({
  integrationDraws: () => false,
}));

import { buildTutorialGateOptions } from "./tutorial-gate-options.js";

describe("buildTutorialGateOptions", () => {
  it("defaults identityApi from isRemoteIdentityConfigured", () => {
    vi.spyOn(identity, "isRemoteIdentityConfigured").mockReturnValue(false);
    vi.spyOn(compositionStore, "getSnapshot").mockReturnValue({
      plan: { capabilities: {} },
    } as ReturnType<typeof compositionStore.getSnapshot>);
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "locked",
      guest: false,
      tomb: null,
    } as ReturnType<typeof vaultStore.getSnapshot>);
    buildTutorialGateOptions();
    expect(identity.isRemoteIdentityConfigured).toHaveBeenCalled();
    const forced = buildTutorialGateOptions(true);
    expect(forced.sectionDrawn("feature.identity")).toBe(true);
  });
});