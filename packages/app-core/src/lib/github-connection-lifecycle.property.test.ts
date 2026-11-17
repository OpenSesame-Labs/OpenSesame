/** @vitest-environment jsdom */
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  deleteBackupTarget,
  getBackupStatus,
  hasWorkingBackupTarget,
  putBackupTarget,
  setBackupTargetEnabled,
} from "./backup.js";
import { backupEgressGate } from "./backup-egress-gate.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { stopVaultBackupObserver } from "./vault-backup-observer.js";

// Exercise local state under a policy that prohibits backup network calls.
beforeEach(() => vi.spyOn(backupEgressGate, "running").mockReturnValue(false));

const confirmedAt = "2026-01-01T00:00:00.000Z";
const operations = [
  "default-alpha",
  "default-beta",
  "on-alpha",
  "on-beta",
  "off-alpha",
  "off-beta",
  "enable",
  "disable",
  "confirm",
  "delete",
  "invalid",
] as const;
type Operation = (typeof operations)[number];
type Binding = "none" | "alpha" | "beta";
type Model = { binding: Binding; enabled: boolean; confirmed: boolean };

afterEach(() => {
  stopVaultBackupObserver();
  clearLocalBackupTarget();
  vi.restoreAllMocks();
});

async function configure(action: Operation, model: Model): Promise<void> {
  const choice = action.startsWith("default-")
    ? "default"
    : action.startsWith("on-")
      ? "on"
      : "off";
  const repo = action.endsWith("-alpha") ? "alpha" : "beta";
  const options = choice === "default" ? {} : { enabled: choice === "on" };
  await putBackupTarget({
    installationId: "777",
    owner: "acme",
    repo,
    ...options,
  });
  if (model.binding !== repo) model.confirmed = false;
  if (choice === "default") {
    if (model.binding === "none") model.enabled = false;
  } else model.enabled = choice === "on";
  model.binding = repo;
}

async function setEnabled(value: boolean, model: Model): Promise<void> {
  if (model.binding === "none") {
    await expect(setBackupTargetEnabled(value, "github")).rejects.toThrow(
      "No backup target configured",
    );
  } else {
    await setBackupTargetEnabled(value, "github");
    model.enabled = value;
  }
}

function confirm(model: Model): void {
  if (model.binding === "none" || !model.enabled) return;
  const target = readLocalBackupTarget("github");
  expect(target).not.toBeNull();
  if (target === null) throw new Error("Missing configured target");
  // A stand-in for a successful sync record, not a simulated GitHub.
  writeLocalBackupTarget({
    ...target,
    status: "ok",
    lastCommitSha: "commit",
    lastSyncedAt: confirmedAt,
    lastError: null,
    pendingEvents: 0,
  });
  model.confirmed = true;
}

async function apply(action: Operation, model: Model): Promise<void> {
  if (action.includes("-")) {
    await configure(action, model);
  } else if (action === "enable" || action === "disable") {
    await setEnabled(action === "enable", model);
  } else if (action === "delete") {
    await deleteBackupTarget("github");
    Object.assign(model, { binding: "none", enabled: false, confirmed: false });
  } else if (action === "confirm") {
    confirm(model);
  } else if (action === "invalid" && model.binding === "none") {
    await expect(
      putBackupTarget({ owner: "acme", repo: "alpha" }),
    ).rejects.toThrow("Backup needs a GitHub App installation");
  }
}

async function check(model: Model): Promise<void> {
  const { target } = await getBackupStatus("github");
  if (model.binding === "none") {
    expect(target).toBeNull();
  } else {
    expect(target).toMatchObject({
      kind: "github_app",
      providerId: "github",
      installationId: "777",
      owner: "acme",
      repo: model.binding,
      enabled: model.enabled,
      lastSyncedAt: model.confirmed ? confirmedAt : null,
      lastCommitSha: model.confirmed ? "commit" : null,
      status: model.confirmed ? "ok" : "pending",
    });
  }
  expect(hasWorkingBackupTarget()).toBe(model.enabled && model.confirmed);
}

it("matches the GitHub target lifecycle over generated action sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...operations), { minLength: 1, maxLength: 50 }),
      async (actions: Operation[]) => {
        clearLocalBackupTarget();
        const model: Model = {
          binding: "none",
          enabled: false,
          confirmed: false,
        };
        for (const action of actions) {
          await apply(action, model);
          await check(model);
        }
      },
    ),
    { seed: 2588, numRuns: 250 },
  );
});

it("rejects incomplete GitHub App backup bindings without creating a target", async () => {
  const field = fc.constantFrom("", " ", "valid");
  await fc.assert(
    fc.asyncProperty(
      fc
        .record({ owner: field, repo: field, installationId: field })
        .filter((input) => Object.values(input).some((part) => !part.trim())),
      async (input) => {
        clearLocalBackupTarget();
        await expect(putBackupTarget(input)).rejects.toThrow();
        expect((await getBackupStatus("github")).target).toBeNull();
        expect(hasWorkingBackupTarget()).toBe(false);
      },
    ),
    { seed: 2589, numRuns: 100 },
  );
});

it("does not carry a confirmed backup across changes to any binding field", async () => {
  const changes = [
    { connectionId: "connection-2" },
    { integrationId: "integration-2" },
    { installationId: "888" },
    { owner: "other" },
    { repo: "beta" },
    { branch: "other" },
  ];
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...changes), async (change) => {
      clearLocalBackupTarget();
      await putBackupTarget({
        connectionId: "connection-1",
        integrationId: "integration-1",
        installationId: "777",
        owner: "acme",
        repo: "alpha",
        branch: "main",
        enabled: true,
      });
      const target = readLocalBackupTarget("github");
      if (target === null) throw new Error("Missing configured target");
      writeLocalBackupTarget({
        ...target,
        status: "ok",
        lastCommitSha: "commit",
        lastSyncedAt: confirmedAt,
        lastError: null,
        pendingEvents: 0,
      });
      expect(hasWorkingBackupTarget()).toBe(true);
      await putBackupTarget(change);
      expect((await getBackupStatus("github")).target).toMatchObject({
        ...change,
        enabled: true,
        status: "pending",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      });
      expect(hasWorkingBackupTarget()).toBe(false);
    }),
    { seed: 2591, numRuns: 60 },
  );
});
