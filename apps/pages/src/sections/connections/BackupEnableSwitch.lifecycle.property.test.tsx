/** @vitest-environment jsdom */
import {
  deleteBackupTarget,
  getBackupStatus,
  putBackupTarget,
  setBackupTargetEnabled,
} from "@opensesame/app-core/lib/backup.js";
import { backupEgressGate } from "@opensesame/app-core/lib/backup-egress-gate.js";
import { clearLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { stopVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupEnableSwitch } from "./BackupEnableSwitch.js";

// Exercise the real local configuration and React switch under a policy that
// prohibits backup network calls. A selection is not a GitHub connection.
beforeEach(() => vi.spyOn(backupEgressGate, "running").mockReturnValue(false));

const actions = [
  "save-alpha",
  "save-beta",
  "click",
  "enable",
  "disable",
  "delete",
] as const;

afterEach(() => {
  cleanup();
  stopVaultBackupObserver();
  clearLocalBackupTarget();
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: { providerId: "github", selections: [] },
    },
  });
  vi.restoreAllMocks();
});

it("keeps the visible switch consistent with generated target transitions", async () => {
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: {
        providerId: "github",
        selections: [{ providerId: "github", group: "git" }],
      },
    },
  });

  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...actions), { minLength: 1, maxLength: 20 }),
      async (sequence) => {
        clearLocalBackupTarget();
        let configured = false;
        let enabled = false;
        const view = render(
          <BackupEnableSwitch
            providerId="github"
            displayName="GitHub"
            showSetupHint
          />,
        );
        try {
          const toggle = screen.getByRole("switch", { name: "GitHub backup" });
          for (const action of sequence) {
            if (action === "save-alpha" || action === "save-beta") {
              await act(async () => {
                await putBackupTarget({
                  installationId: "777",
                  owner: "acme",
                  repo: action === "save-alpha" ? "alpha" : "beta",
                });
              });
              configured = true;
            } else if (action === "click") {
              fireEvent.click(toggle);
              if (configured) enabled = !enabled;
            } else if (action === "delete") {
              await act(async () => {
                await deleteBackupTarget("github");
              });
              configured = false;
              enabled = false;
            } else if (configured) {
              await act(async () => {
                await setBackupTargetEnabled(action === "enable", "github");
              });
              enabled = action === "enable";
            }

            await waitFor(() => {
              expect(toggle).toHaveProperty("disabled", !configured);
              expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
              expect(
                Boolean(screen.queryByText("Configure a repository first")),
              ).toBe(!configured);
            });
            expect(
              (await getBackupStatus("github")).target?.enabled ?? false,
            ).toBe(enabled);
          }
        } finally {
          view.unmount();
        }
      },
    ),
    { seed: 2590, numRuns: 35 },
  );
});
