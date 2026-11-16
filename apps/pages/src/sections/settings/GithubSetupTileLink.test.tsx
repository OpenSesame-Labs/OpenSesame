/** @vitest-environment jsdom */
import { clearLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
} from "@opensesame/app-core/lib/connect-roads.js";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { installPanelFixture } from "./settings-panels.test-support.js";

installDoublePorts();
installPanelFixture();
beforeEach(() => clearLocalBackupTarget());
afterEach(() => clearLocalBackupTarget());

function renderBackups() {
  render(
    <MemoryRouter initialEntries={["/settings/integrations"]}>
      <Routes>
        <Route
          path="/settings/integrations"
          element={
            <>
              <Link to="/settings">Leave</Link>
              <ProviderTiles category="backup_recovery" label="Backups" />
            </>
          }
        />
        <Route
          path="/settings/connections/github"
          element={<h1>GitHub setup</h1>}
        />
        <Route path="/settings" element={<h1>Other settings</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

it("turns on Connections on request and opens the chosen GitHub page", async () => {
  renderBackups();
  fireEvent.click(screen.getByRole("button", { name: /GitHub.*Connections/ }));
  await waitFor(() => expect(double.commits).toHaveLength(1));
  expect(double.commits[0]?.draft.selectedOptional).toContain(
    "connectors.external",
  );
  expect(screen.queryByRole("heading", { name: "GitHub setup" })).toBeNull();
  act(() => {
    connectRoadSeams.pagesOpen = () => true;
    notifyConnectRoads();
  });
  await screen.findByRole("heading", { name: "GitHub setup" });
});

it("explains when Connections cannot be enabled on this device", () => {
  const snapshot = capabilityPorts.compositionStore.getSnapshot();
  if (!snapshot.plan) throw new Error("Missing capability plan");
  const connections = snapshot.plan.capabilities["connectors.external"];
  if (!connections) throw new Error("Missing Connections capability");
  const unavailable = {
    ...snapshot,
    plan: {
      ...snapshot.plan,
      capabilities: {
        ...snapshot.plan.capabilities,
        "connectors.external": { ...connections, permitted: false },
      },
    },
  };
  vi.spyOn(capabilityPorts.compositionStore, "getSnapshot").mockReturnValue(
    unavailable,
  );
  renderBackups();
  expect(
    screen.getByText("Connections is not available on this device"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /GitHub.*Connections/ }),
  ).toBeNull();
  expect(double.commits).toHaveLength(0);
  vi.restoreAllMocks();
});

it("does not navigate back when the person leaves while Connections starts", async () => {
  let finish: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = capabilityPorts.compositionStore.commit.bind(
    capabilityPorts.compositionStore,
  );
  vi.spyOn(capabilityPorts.compositionStore, "commit").mockImplementationOnce(
    async (...args) => {
      await waiting;
      return original(...args);
    },
  );
  renderBackups();
  fireEvent.click(screen.getByRole("button", { name: /GitHub.*Connections/ }));
  fireEvent.click(screen.getByRole("link", { name: "Leave" }));
  await screen.findByRole("heading", { name: "Other settings" });
  await act(async () => {
    finish?.();
    await waiting;
  });
  act(() => {
    connectRoadSeams.pagesOpen = () => true;
    notifyConnectRoads();
  });
  expect(screen.getByRole("heading", { name: "Other settings" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "GitHub setup" })).toBeNull();
  vi.restoreAllMocks();
});

it("stays on Integrations when turning on Connections is refused", async () => {
  // The double deliberately refuses the same commit used by Features.
  vi.spyOn(capabilityPorts.compositionStore, "commit").mockResolvedValueOnce({
    status: "refused",
    reason: "managed-invalid",
  });
  renderBackups();
  fireEvent.click(screen.getByRole("button", { name: /GitHub.*Connections/ }));
  await expectInTray("refused · managed-invalid");
  expect(screen.getByRole("list", { name: "Backups" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "GitHub setup" })).toBeNull();
  vi.restoreAllMocks();
});
