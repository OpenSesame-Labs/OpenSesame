import {
  backupSeams,
  putBackupTarget,
} from "@opensesame/app-core/lib/backup.js";
import { clearLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import {
  isHistorySelected,
  loadHistorySelections,
} from "@opensesame/app-core/lib/history-backups.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { stopVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderTiles } from "./ProviderTiles.js";

const originalBackup = { ...backupSeams };

afterEach(() => {
  cleanup();
  stopVaultBackupObserver();
  clearLocalBackupTarget();
  resetConnectRoadSeams();
  Object.assign(backupSeams, originalBackup);
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: { providerId: "github" },
    },
  });
});

beforeEach(() => {
  Object.assign(backupSeams, {
    getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    setBackupTargetEnabled: vi.fn(async (enabled: boolean) => ({
      kind: "github_app",
      providerId: null,
      connectionId: null,
      integrationId: "int_1",
      installationId: "99",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled,
      status: "ok",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
    })),
  });
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      history: {
        providerId: "gitlab",
        selections: [
          {
            providerId: "gitlab",
            group: "git",
            connectionId: "conn_gl",
            remote: "https://gitlab.com/acme/vault.git",
          },
        ],
      },
    },
  });
});

describe("ProviderTiles backup target reads", () => {
  it("reads the saved backup target only for the backup group", async () => {
    const status = vi.fn(async () => ({ target: null, pendingEvents: 0 }));
    Object.assign(backupSeams, { getBackupStatus: status });
    render(
      <MemoryRouter>
        <ProviderTiles category="password_managers" label="Password managers" />
        <ProviderTiles category="identity" label="Identity providers" />
      </MemoryRouter>,
    );
    expect(status).not.toHaveBeenCalled();
    cleanup();
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(status).toHaveBeenCalled());
  });
});

describe("ProviderTiles backup toggles", () => {
  it("puts a history switch on unbound backup connectors", async () => {
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("switch", { name: "GitLab vault history" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("https://gitlab.com/acme/vault.git")).toBeTruthy();
  });

  it("toggles vault history when no saved backup target is bound", async () => {
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "GitLab vault history" }),
    );
    expect(isHistorySelected("gitlab")).toBe(false);
    fireEvent.click(
      screen.getByRole("switch", { name: "Bitbucket vault history" }),
    );
    expect(
      loadHistorySelections().some((row) => row.providerId === "bitbucket"),
    ).toBe(true);
  });

  it("does not present a legacy GitHub selection as an enabled backup", async () => {
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
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    const github = screen.getByRole("switch", { name: "GitHub backup" });
    expect(github.getAttribute("aria-checked")).toBe("false");
    expect(github).toHaveProperty("disabled", true);
    expect(screen.getByText("Turn on Connections and configure")).toBeTruthy();
    fireEvent.click(github);
    expect(isHistorySelected("github")).toBe(true);
    expect(backupSeams.setBackupTargetEnabled).not.toHaveBeenCalled();
  });

  it("drives the saved target's enable flag for a configured GitHub App", async () => {
    Object.assign(backupSeams, {
      getBackupStatus: vi.fn(async () => ({
        target: {
          kind: "github_app",
          providerId: null,
          connectionId: "conn_gh",
          integrationId: "int_1",
          installationId: "99",
          owner: "acme",
          repo: "vault",
          branch: "main",
          enabled: true,
          status: "ok",
          lastCommitSha: null,
          lastSyncedAt: null,
          lastError: null,
          config: null,
        },
        pendingEvents: 0,
      })),
    });
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    const github = await waitFor(() =>
      screen.getByRole("switch", { name: "GitHub backup" }),
    );
    expect(github.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("acme/vault")).toBeTruthy();
    expect(screen.getByText("Turn on Connections and configure")).toBeTruthy();
    fireEvent.click(github);
    await waitFor(() =>
      expect(backupSeams.setBackupTargetEnabled).toHaveBeenCalledWith(
        false,
        "github",
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "GitHub backup" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("updates the tile when a GitHub repository is configured and enabled", async () => {
    Object.assign(backupSeams, originalBackup);
    clearLocalBackupTarget();
    connectRoadSeams.pagesOpen = () => true;
    notifyConnectRoads();
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("switch", { name: "GitHub backup" });
    expect(toggle).toHaveProperty("disabled", true);
    await act(async () => {
      await putBackupTarget({
        installationId: "99",
        owner: "acme",
        repo: "vault",
      });
    });
    await waitFor(() => expect(screen.getByText("acme/vault")).toBeTruthy());
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByText("Automatic backups have not started")).toBeTruthy();
  });
});

describe("ProviderTiles never link to a page nothing routes", () => {
  it("draws a history road as its switch alone while Connections is off", async () => {
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    expect(screen.getByText("GitLab")).toBeTruthy();
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(
      screen.getByRole("button", { name: /GitHub.*Connections/ }),
    ).toBeTruthy();
    // Nothing interactive wears the link's hover: the linkless face is its own class.
    expect(document.querySelector("span.conn-tile__link")).toBeNull();
    expect(document.querySelector("span.conn-tile__face")).not.toBeNull();
  });

  it("keeps GitHub off without a repository, and links to setup when routed", async () => {
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
    const view = render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("switch", { name: "GitHub backup" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Turn on Connections and configure")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /GitHub.*Connections/ }),
    ).toBeTruthy();
    view.unmount();
    connectRoadSeams.pagesOpen = () => true;
    notifyConnectRoads();
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("link", { name: /GitHub/ }).getAttribute("href"),
    ).toBe("/settings/connections/github");
    expect(
      screen.getByRole("switch", { name: "GitHub backup" }),
    ).toHaveProperty("disabled", true);
  });

  it("draws no tile for a connector whose only road is its page", () => {
    render(
      <MemoryRouter>
        <ProviderTiles category="password_managers" label="Password managers" />
        <ProviderTiles category="identity" label="Identity providers" />
      </MemoryRouter>,
    );
    expect(screen.queryAllByRole("listitem")).toEqual([]);
  });

  it("links each tile to its page once Connections routes them", async () => {
    connectRoadSeams.pagesOpen = () => true;
    notifyConnectRoads();
    render(
      <MemoryRouter>
        <ProviderTiles category="backup_recovery" label="Backups" />
        <ProviderTiles category="password_managers" label="Password managers" />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "GitLab vault history" }),
      ).toBeTruthy(),
    );
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/settings/connections/gitlab");
    expect(hrefs).toContain("/settings/connections/1password");
  });
});
