/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalBackupTarget,
  type LocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  backupSeams,
  branchForEnvironment,
  filterGithubBackupConnections,
  getBackupStatus,
  hasWorkingBackupTarget,
  installationIdFromLocation,
  ownerRepoFromRemote,
  putBackupTarget,
  resyncBackup,
  setBackupTargetEnabled,
} from "./backup.js";
import {
  publishBackupSyncEvent,
  subscribeBackupSyncEvents,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";

const originalSync = { ...vaultBackupSyncSeams };
const originalBackup = { ...backupSeams };

beforeEach(() => {
  clearLocalBackupTarget();
  Object.assign(vaultBackupSyncSeams, originalSync);
  Object.assign(backupSeams, originalBackup);
});

afterEach(() => {
  Object.assign(vaultBackupSyncSeams, originalSync);
  Object.assign(backupSeams, originalBackup);
});

describe("browser-local backup target", () => {
  it("counts a working backup on any target, not only the first row", () => {
    // Gauntlet round 4 (kimi): the storage warning read rows[0] only, so a
    // healthy second target never withdrew a warning that claimed there was
    // "no copy anywhere else yet".
    const row = (over: Partial<LocalBackupTarget>): LocalBackupTarget => ({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "777",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "ready",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: "offline",
      config: null,
      pendingEvents: 3,
      ...over,
    });
    writeLocalBackupTarget(row({}));
    expect(hasWorkingBackupTarget()).toBe(false);
    // Enabled but never synced, then failing/behind: still not working.
    writeLocalBackupTarget(row({ lastError: null, pendingEvents: 0 }));
    expect(hasWorkingBackupTarget()).toBe(false);
    writeLocalBackupTarget(
      row({ lastSyncedAt: "2026-01-01T00:00:00Z", pendingEvents: 0 }),
    );
    expect(hasWorkingBackupTarget()).toBe(false);
    writeLocalBackupTarget(
      row({
        kind: "git_remote",
        providerId: "git_remote",
        connectionId: "conn_2",
        lastError: null,
        lastSyncedAt: "2026-01-01T00:00:00Z",
        pendingEvents: 0,
      }),
    );
    expect(hasWorkingBackupTarget()).toBe(true);
  });

  it("stores a target on this device and reports it", async () => {
    const target = await putBackupTarget({
      connectionId: "conn_1",
      installationId: "777",
      owner: "acme",
      repo: "opensesame-passwords",
      branch: "main",
      enabled: true,
    });
    expect(target.repo).toBe("opensesame-passwords");
    expect(target.enabled).toBe(true);
    const status = await getBackupStatus();
    expect(status.target?.owner).toBe("acme");
    expect(status.target?.connectionId).toBe("conn_1");
  });

  it("publishes configured when a repo is bound while enabled", async () => {
    const events: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      events.push(event.reason);
    });
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => '{"format":"opensesame-offline-backup"}',
      putContents: vi.fn(async () => ({ commitSha: "abc" })),
    });
    await putBackupTarget({
      installationId: "9",
      owner: "acme",
      repo: "vault",
      enabled: true,
    });
    expect(events).toContain("configured");
    stop();
  });

  it("publishes enabled when backup is turned back on", async () => {
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => "{}",
      putContents: vi.fn(async () => ({ commitSha: "def" })),
    });
    await putBackupTarget({
      installationId: "9",
      owner: "acme",
      repo: "vault",
      enabled: false,
    });
    const events: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      events.push(event.reason);
    });
    await setBackupTargetEnabled(true);
    expect(events).toContain("enabled");
    stop();
  });

  it("manual resync invokes the backup seam", async () => {
    const sync = vi.fn(async () => undefined);
    Object.assign(backupSeams, { resyncBackup: sync });
    await resyncBackup();
    expect(sync).toHaveBeenCalled();
  });

  it("maps remotes and environments to owner/repo/branch", () => {
    expect(
      ownerRepoFromRemote("https://github.com/acme/opensesame-passwords.git"),
    ).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    expect(ownerRepoFromRemote("acme/opensesame-passwords")).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    expect(ownerRepoFromRemote("https://github.com/acme")).toBeNull();
    expect(branchForEnvironment("production")).toBe("env/production");
    expect(branchForEnvironment("development")).toBe("env/development");
  });

  it("rejects remotes with query, fragment, or whitespace", () => {
    expect(ownerRepoFromRemote("https://github.com/acme/repo")).toEqual({
      owner: "acme",
      repo: "repo",
    });
    expect(ownerRepoFromRemote("https://github.com/acme/repo.git")).toEqual({
      owner: "acme",
      repo: "repo",
    });
    expect(
      ownerRepoFromRemote("https://github.com/acme/repo?tab=readme"),
    ).toBeNull();
    expect(
      ownerRepoFromRemote("https://github.com/acme/repo#readme"),
    ).toBeNull();
    expect(ownerRepoFromRemote("https://github.com/acme/re po")).toBeNull();
    expect(ownerRepoFromRemote("https://github.com/ac me/repo")).toBeNull();
    expect(branchForEnvironment("development")).toBe("env/development");
  });

  it("lists only active GitHub connections for recoverability", () => {
    expect(
      filterGithubBackupConnections([
        { providerId: "github", status: "active" },
        { providerId: "github", status: "needs_reauth" },
        { providerId: "gitlab", status: "active" },
      ]),
    ).toEqual([{ providerId: "github", status: "active" }]);
  });

  it("reads installation id from the return location", () => {
    expect(installationIdFromLocation("?installation_id=42")).toBe("42");
    expect(installationIdFromLocation("installationId=7")).toBe("7");
    expect(installationIdFromLocation("")).toBeNull();
  });
});

describe("backup sync event bus", () => {
  it("notifies subscribers for webhook nudges", () => {
    const seen: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      seen.push(event.reason);
    });
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => "{}",
      putContents: vi.fn(async () => ({ commitSha: "w" })),
    });
    // No target → runSync no-ops after publish
    publishBackupSyncEvent("webhook");
    expect(seen).toEqual(["webhook"]);
    stop();
  });
});
