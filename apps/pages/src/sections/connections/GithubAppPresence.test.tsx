import { backupSeams } from "@opensesame/app-core/lib/backup.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { rememberLocalGithubApp } from "@opensesame/app-core/lib/github-app-local.js";
import { forgetLocalGithubApp } from "@opensesame/app-core/lib/github-app-manifest.js";
import { localStore } from "@opensesame/app-core/ports.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppPresence } from "./GithubAppPresence.js";

const PUBLIC_KEY = "opensesame.github-app.public";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("GithubAppPresence", () => {
  const originalBackup = { ...backupSeams };
  const originalConnections = { ...connectionSeams };

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => [
        {
          id: "4242",
          accountLogin: "acme-corp",
          accountType: "Organization",
          targetType: "Organization",
          repositorySelection: "selected",
          permissions: [
            { name: "contents", access: "write" },
            { name: "metadata", access: "read" },
          ],
          repositories: ["acme-corp/vault"],
        },
      ]),
      getBackupStatus: vi.fn(async () => ({
        target: {
          kind: "github_app",
          integrationId: "int-gh",
          installationId: "4242",
          owner: "acme-corp",
          repo: "vault",
          branch: "main",
          enabled: true,
          status: "ok",
          lastCommitSha: null,
          lastSyncedAt: null,
          lastError: null,
        },
        pendingEvents: 0,
      })),
    });
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => [
        {
          id: "int-gh",
          key: "github-oauth",
          providerId: "github",
          displayName: "OpenSesame",
          source: "organization",
          enabled: true,
          configured: true,
          scopes: [],
          githubAppHtmlUrl: "https://github.com/apps/opensesame",
        },
      ]),
    });
  });

  afterEach(() => {
    cleanup();
    Object.assign(backupSeams, originalBackup);
    Object.assign(connectionSeams, originalConnections);
    vi.unstubAllGlobals();
  });

  it("shows Host install config: name, account, permissions, repository", async () => {
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-install").textContent).toContain(
        "acme-corp",
      );
    });
    expect(screen.getByTestId("github-app-name").textContent).toContain(
      "OpenSesame",
    );
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "Organization",
    );
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "repos selected",
    );
    await waitFor(() => {
      expect(screen.getByTestId("github-backup-repo").textContent).toContain(
        "acme-corp/vault",
      );
    });
    expect(screen.getByTestId("github-app-granted").textContent).toContain(
      "contents",
    );
    expect(screen.getByTestId("github-app-repos").textContent).toContain(
      "acme-corp/vault",
    );
  });

  it("unlocks the repository field for editing", async () => {
    const onFlash = vi.fn();
    localStore().setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: "acme-corp",
        ownerType: "Organization",
        installedByLogin: null,
        installations: [
          {
            id: "4242",
            accountLogin: "acme-corp",
            accountType: "Organization",
          },
        ],
      }),
    );
    render(<GithubAppPresence online onFlash={onFlash} />);
    await waitFor(() => {
      expect(screen.getByTestId("github-backup-repo").textContent).toContain(
        "acme-corp/vault",
      );
    });
    expect(screen.queryByLabelText("Repository")).toBeNull();
    await userEvent.click(screen.getByTestId("github-repo-edit"));
    const input = await screen.findByTestId("github-repo-input");
    expect(input).toHaveProperty("disabled", false);
  });

  it("shows local App registrant when stored", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStore().setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [
          {
            id: "999",
            accountLogin: "real-org",
            accountType: "Organization",
          },
        ],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "real-org",
    );
  });
  // A guest's App now lives in that guest's own vault, and its claim is
  // covered by github-app-registration.test.ts. Here the claim's publication
  // lands after an empty mount.
  it("shows the registrant when a claim finishes after empty mount", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    render(<GithubAppPresence />);
    expect(screen.queryByTestId("github-app-presence")).toBeNull();
    rememberLocalGithubApp({
      id: "4997182",
      key: "github-oauth",
      displayName: "OpenSesame Local",
      htmlUrl: "https://github.com/apps/opensesame-local",
      ownerLogin: "Tyler-R-Kendrick",
      ownerType: "User",
      installedByLogin: null,
      installations: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
  });

  it("clears the registrant when Remove forgets the local App", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStore().setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "4997182",
        key: "github-oauth",
        displayName: "OpenSesame Local",
        htmlUrl: "https://github.com/apps/opensesame-local",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
    // Forget control lives next to the connector title on SettingsPage.
    forgetLocalGithubApp();
    await waitFor(() => {
      expect(screen.queryByTestId("github-app-presence")).toBeNull();
    });
    expect(localStore().getItem(PUBLIC_KEY)).toBeNull();
  });

  it("warns when the App is stored without a registrant", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStore().setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: null,
        ownerType: null,
        installedByLogin: null,
        installations: [],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(
        screen.getByTestId("github-app-owner-missing").textContent,
      ).toContain("unknown");
    });
  });
});
