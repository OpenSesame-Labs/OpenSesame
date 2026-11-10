/** @vitest-environment jsdom */

import { cleanup, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerContributedShell,
  renderShell,
  resetShellRender,
  vault,
} from "../components/app-shell.test-harness.js";
import { stubScreen } from "../lib/use-narrow.test-support.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { VaultSection } from "./VaultSection.js";
import "./vault/commands.test-support.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";

Object.assign(vaultHooksSeams, { useCopySecret: () => vi.fn() });
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

/** The vault section inside the real shell, as a phone draws it. */
function renderVault(path: string) {
  return renderShell(
    path,
    <Routes>
      <Route path="/vault" element={<VaultSection />}>
        <Route index element={<div>welcome pane</div>} />
      </Route>
    </Routes>,
  );
}

/** Which pane holds the first-run road: the section tree, or the list. */
function roadPane(): string | undefined {
  return screen
    .getByText(/Add your first password/)
    .closest(".vault__tree, .vault__list")?.className;
}

describe("an empty vault on a phone (ADR 0221)", () => {
  let revoke: readonly (() => void)[] = [];
  beforeEach(() => {
    revoke = registerContributedShell();
    vault.items = [];
    vault.folders = [];
    stubScreen({ narrow: true, coarse: true });
  });
  afterEach(() => {
    resetShellRender();
    for (const undo of revoke) undo();
    vi.unstubAllGlobals();
  });

  it("draws the first-run roads on the section tree it lands on", () => {
    // A phone opens on the tree. The roads stand there, not one tap away
    // behind a filter a newcomer has no reason to press.
    renderVault("/vault");
    expect(screen.getAllByText(/Add your first password/)).toHaveLength(1);
    expect(roadPane()).toContain("vault__tree");
  });

  it("draws them once: both panes are mounted, one copy exists", () => {
    renderVault("/vault?f=all");
    expect(screen.getAllByText(/Add your first password/)).toHaveLength(1);
    expect(roadPane()).toContain("vault__list");
    cleanup();
  });
});
