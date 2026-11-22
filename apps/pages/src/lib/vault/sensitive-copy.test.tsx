/** @vitest-environment jsdom */
import { identityAccountFactorTransport } from "@opensesame/app-core/lib/account-factors.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretBackendItemFields } from "../../sections/connections/secret-backends/SecretBackendItemFields.js";
import { TailscaleDevicePanel } from "../../sections/connections/tailscale/TailscaleDevicePanel.js";
import type { TailscaleEditor } from "../../sections/connections/tailscale/useTailscaleApp.js";
import { AccountTotpCeremony } from "../../sections/settings/security/AccountTotpCeremony.js";
import { DeadmanPanelView } from "../../sections/settings/security/DeadmanPanelView.js";
import type { DeadmanPanelModel } from "../../sections/settings/security/deadman-panel-actions.js";
import {
  AuthenticatorCeremony,
  RecoveryCeremony,
} from "../../sections/settings/security/SecondStepCeremonies.js";
import { EnvironmentFieldsRead } from "../../sections/vault/EnvironmentFields.js";
import { clearCopiedSecret, vaultHooksSeams } from "./hooks.js";

const originalSeams = { ...vaultHooksSeams };
let clipboardValue = "";
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clipboardValue = "";
  writeText = vi.fn(async (value: string) => {
    clipboardValue = value;
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText: vi.fn(async () => clipboardValue) },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(async () => ({ state: "granted" })) },
  });
});

afterEach(async () => {
  cleanup();
  clearCopiedSecret();
  await Promise.resolve();
  await Promise.resolve();
  Object.assign(vaultHooksSeams, originalSeams);
  vi.restoreAllMocks();
});

async function expectLockClears(value: string) {
  await waitFor(() => expect(clipboardValue).toBe(value));
  clearCopiedSecret();
  await waitFor(() => expect(clipboardValue).toBe(""));
  expect(writeText).toHaveBeenLastCalledWith("");
}

const run = async (action: () => Promise<void>) => action();

describe("sensitive copy controls", () => {
  it("tracks recovery codes and clears them on lock", async () => {
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({
        recoveryCodes: async () => ({
          codes: ["recovery-one", "used-code"],
          used: [false, true],
          since: "2026-01-01T00:00:00Z",
        }),
      }),
    });
    render(<RecoveryCeremony busy={false} run={run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await expectLockClears("recovery-one\n");
  });

  it("tracks newly generated recovery codes before the ceremony closes", async () => {
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({
        recoveryCodes: async () => ({
          codes: ["old-code"],
          used: [false],
          since: "2026-01-01T00:00:00Z",
        }),
        generateRecoveryCodes: async () => ["new-code"],
      }),
    });
    render(<RecoveryCeremony busy={false} run={run} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Make a new set" }),
    );
    const buttons = screen.getAllByRole("button", { name: "Make a new set" });
    const action = buttons[buttons.length - 1];
    if (!action) throw new Error("regeneration action missing");
    fireEvent.click(action);
    await screen.findByText("Recovery codes · shown once");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await expectLockClears("new-code\n");
  });

  it("tracks vault authenticator setup keys", async () => {
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({
        beginTotpEnrollment: async () =>
          "otpauth://totp/demo?secret=VAULTCANARY",
        cancelTotpEnrollment: vi.fn(),
      }),
    });
    render(
      <AuthenticatorCeremony
        view="add"
        enrolled={["passkey"]}
        host={{ ok: true, hostname: "localhost", fixUrl: null, reason: "" }}
        busy={false}
        run={run}
        onDone={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Can't scan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy setup key" }));
    await expectLockClears("VAULTCANARY");
  });

  it("tracks account authenticator setup keys", async () => {
    vi.spyOn(identityAccountFactorTransport, "signedIn").mockReturnValue(true);
    vi.spyOn(identityAccountFactorTransport, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            otpauthUrl: "otpauth://totp/demo?secret=ACCOUNTCANARY",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    render(<AccountTotpCeremony busy={false} run={run} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Can't scan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy setup key" }));
    await expectLockClears("ACCOUNTCANARY");
  });

  it("tracks a secret backend value", async () => {
    render(
      <SecretBackendItemFields
        draft={{
          name: "Example",
          kind: "secret",
          secret: "backend-canary",
          notes: "",
        }}
        editing
        busy={false}
        existing={false}
        onChange={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy backend secret" }),
    );
    await expectLockClears("backend-canary");
  });

  it("tracks a deadman release key", async () => {
    const model: DeadmanPanelModel = overlapCast({
      open: true,
      plan: {},
      releaseKey: "release-canary",
      stored: false,
      busy: false,
      error: "",
      said: "",
      setStored: vi.fn(),
    });
    render(
      <DeadmanPanelView
        model={model}
        choices={[]}
        row={null}
        prepare={vi.fn()}
        commit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy release key" }));
    await expectLockClears("release-canary");
  });

  it("tracks a Tailscale device auth key", async () => {
    const model: TailscaleEditor = overlapCast({
      key: { key: "device-canary", singleUse: true },
      deviceKey: "",
      busy: false,
      ready: false,
      setDeviceKey: vi.fn(),
      cancel: vi.fn(),
    });
    render(<TailscaleDevicePanel model={model} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Tailscale device auth key" }),
    );
    await expectLockClears("device-canary");
  });

  it("tracks copied generated environment text", async () => {
    render(
      <EnvironmentFieldsRead
        itemName="Example"
        values={{
          environment: "development",
          schema: "API_KEY=example-canary\n",
          aliases: "",
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Copy Example\.development\.env\.schema/,
      }),
    );
    await waitFor(() => expect(clipboardValue).toContain("example-canary"));
    clearCopiedSecret();
    await waitFor(() => expect(clipboardValue).toBe(""));
  });

  it("does not report a recovery copy as successful if the clipboard is unavailable", async () => {
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({
        recoveryCodes: async () => ({
          codes: ["recovery-one"],
          used: [false],
          since: "2026-01-01T00:00:00Z",
        }),
      }),
    });
    writeText.mockRejectedValue(new Error("denied"));
    render(<RecoveryCeremony busy={false} run={run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
