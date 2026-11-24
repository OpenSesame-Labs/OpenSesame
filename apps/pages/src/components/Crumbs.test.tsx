/** @vitest-environment jsdom */

import { registerLegacyShellData } from "@opensesame/app-core/lib/contributions.test-support.js";
import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { kvFileName } from "@opensesame/app-core/lib/kv.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../sections/connections/connect/native-connector-integration.test-support.js";
import { CrumbTrail, Crumbs, useCrumbs } from "./Crumbs.js";

describe("Crumbs", () => {
  const vault = {
    items: [
      {
        id: "itm_1",
        name: "Work SSH",
        folderId: "fld_1",
      },
    ],
    folders: [{ id: "fld_1", name: "Work" }],
  };

  Object.assign(vaultHooksSeams, {
    useVault: () => vault,
  });

  // A crumb path under Connections exists only while that capability does.
  let revokeShell = () => {};
  beforeAll(() => {
    revokeShell = registerLegacyShellData();
  });
  afterAll(() => revokeShell());

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Crumbs />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  afterEach(cleanup);

  describe("Crumbs", () => {
    it("navigates ancestor crumbs on a vault item rest path", () => {
      renderAt("/vault/itm_1");
      const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(nav.textContent).toContain("Vault");
      expect(nav.textContent).toContain("Work");
      expect(nav.textContent).toContain("Work SSH");
      expect(
        screen.getByRole("link", { name: "Vault" }).getAttribute("href"),
      ).toBe("/vault");
      expect(
        screen.getByRole("link", { name: "Work" }).getAttribute("href"),
      ).toBe("/vault?folder=fld_1");
      expect(screen.queryByRole("link", { name: "Work SSH" })).toBeNull();
    });

    it("leaves a settings tab to its tab strip, and paths a connection", () => {
      // "Settings › Capabilities" only repeated the selected tab, and drawing
      // it on sub-tabs alone moved the title between siblings.
      const { unmount } = renderAt("/settings/connections");
      expect(
        screen.queryByRole("navigation", { name: "Breadcrumb" }),
      ).toBeNull();
      unmount();

      renderAt("/connections/github/conn_1");
      expect(
        screen.getByRole("link", { name: "Connections" }).getAttribute("href"),
      ).toBe("/connections");
      expect(
        screen.getByRole("link", { name: "github" }).getAttribute("href"),
      ).toBe("/connections/github");
    });

    it("marks a vault path as the phone's row, and hands the list strip the same trail", () => {
      // Beside the list the path is the strip's label (VaultPathbar); the
      // shell's row over both panes came and went with the route.
      const { container, unmount } = renderAt("/vault/itm_1");
      expect(container.querySelector("nav.crumbs")?.className).toBe(
        "crumbs crumbs--vault",
      );
      unmount();

      function Strip() {
        return (
          <CrumbTrail
            crumbs={useCrumbs()}
            className="vtree__crumbs"
            label="Vault path"
          />
        );
      }
      render(
        <MemoryRouter initialEntries={["/vault/new/login"]}>
          <Strip />
        </MemoryRouter>,
      );
      const strip = screen.getByRole("navigation", { name: "Vault path" });
      expect(strip.textContent).toBe("VaultNew account");
    });
  });
});

describe("native integration", () => {
  installConnectorIntegration();
  let releaseShell = () => {};
  beforeAll(() => {
    releaseShell = registerLegacyShellData();
  });
  afterAll(() => releaseShell());

  function RouteAddress() {
    return <output aria-label="Route address">{useLocation().pathname}</output>;
  }

  function draw(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Crumbs />
        <RouteAddress />
      </MemoryRouter>,
    );
  }

  const input = {
    providerId: "adobe",
    method: "mcp" as const,
    displayName: "Adobe protocol proof",
    parameters: {},
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  };

  it("uses the actual saved MCP name after encrypted reload while retaining its provider crumb and ID route", async () => {
    const fixture = connectorIntegration();
    const saved = await nativeConnectorDriver("mcp", "adobe").configure(input);
    await fixture.reload();
    const path = `/connections/adobe/${saved.connectionId}`;
    draw(path);
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Adobe protocol proof",
    );
    expect(trail.textContent).not.toContain(saved.connectionId);
    expect(
      screen.getByRole("link", { name: "adobe" }).getAttribute("href"),
    ).toBe("/connections/adobe");
    expect(screen.getByLabelText("Route address").textContent).toBe(path);
    expect(fixture.requests).toHaveLength(0);
  });

  it("updates a mounted record heading only after a committed rename and retains it when a durable write fails", async () => {
    const fixture = connectorIntegration();
    const driver = nativeConnectorDriver("mcp", "adobe");
    const saved = await driver.configure(input);
    const path = `/connections/adobe/${saved.connectionId}`;
    draw(path);
    await act(async () => {
      await driver.configure({
        ...input,
        displayName: "Adobe production tools",
        connectionId: saved.connectionId,
        revision: saved.revision,
      });
    });
    expect(screen.getByText("Adobe production tools")).toBeTruthy();
    const publicChanges = vi.fn();
    const unsubscribe = subscribeDeviceRows(publicChanges);
    const original = fixture.disk.getFileHandle.bind(fixture.disk);
    const brokenDisk = vi
      .spyOn(fixture.disk, "getFileHandle")
      .mockImplementation(async (name, options) => {
        if (
          options?.create &&
          name === kvFileName("opensesame.self-hosted-connectors.v1")
        )
          throw new Error("Device storage write failed");
        return original(name, options);
      });
    await act(async () => {
      await expect(
        driver.configure({
          ...input,
          displayName: "Unsaved name",
          connectionId: saved.connectionId,
          revision: saved.revision + 1,
        }),
      ).rejects.toThrow("Device storage write failed");
    });
    expect(publicChanges).not.toHaveBeenCalled();
    unsubscribe();
    brokenDisk.mockRestore();
    expect(screen.queryByText("Unsaved name")).toBeNull();
    expect(screen.getByText("Adobe production tools")).toBeTruthy();
    expect(screen.getByLabelText("Route address").textContent).toBe(path);
    cleanup();
    await fixture.reload();
    draw(path);
    expect(screen.getByText("Adobe production tools")).toBeTruthy();
  });

  it("uses the saved name on Settings connector routes and cannot borrow another provider's record label", async () => {
    connectorIntegration();
    const saved = await nativeConnectorDriver("mcp", "adobe").configure(input);
    draw(`/settings/connections/adobe/${saved.connectionId}`);
    expect(screen.getByText("Adobe protocol proof")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "adobe" }).getAttribute("href"),
    ).toBe("/settings/connections/adobe");
    cleanup();
    draw(`/connections/notion/${saved.connectionId}`);
    expect(screen.queryByText("Adobe protocol proof")).toBeNull();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Connection",
    );
    expect(trail.textContent).not.toContain(saved.connectionId);
  });
});
