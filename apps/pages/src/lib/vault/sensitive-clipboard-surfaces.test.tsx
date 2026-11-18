/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretBackendItemFields } from "../../sections/connections/secret-backends/SecretBackendItemFields.js";
import {
  AuthenticatorCeremony,
  RecoveryCeremony,
} from "../../sections/settings/security/SecondStepCeremonies.js";
import { EnvironmentFieldsRead } from "../../sections/vault/EnvironmentFields.js";
import { clearCopiedSecret } from "./hooks.js";

let contents = "";
const writeText = vi.fn(async (value: string) => {
  contents = value;
});

beforeEach(() => {
  contents = "";
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText: async () => contents },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: "granted" }) },
  });
  act(() => vaultStore.setPrefs({ clipboardClearSeconds: 30 }));
});

afterEach(async () => {
  await act(async () => {
    clearCopiedSecret();
    await Promise.resolve();
    await Promise.resolve();
  });
  cleanup();
  clearNotices();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function clickCopy(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

async function lockClear(): Promise<void> {
  await act(async () => {
    clearCopiedSecret();
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("routes a backend password through lock-time cleanup", async () => {
  render(
    <SecretBackendItemFields
      draft={{
        name: "Backend",
        kind: "login",
        secret: "backend-password",
        notes: "",
      }}
      editing={false}
      busy={false}
      existing
      onChange={() => {}}
    />,
  );
  await clickCopy("Copy backend secret");
  expect(contents).toBe("backend-password");
  await lockClear();
  expect(contents).toBe("");
});

it("routes a generated environment file through the timed cleanup", async () => {
  vi.useFakeTimers();
  render(
    <EnvironmentFieldsRead
      itemName="Billing"
      values={{ environment: "prod", schema: "DATABASE_URL=", aliases: "" }}
    />,
  );
  await clickCopy("Copy Billing.prod.env.schema");
  expect(contents).toContain("DATABASE_URL=");
  await act(async () => {
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(contents).toBe("");
});

it("routes existing recovery codes through lock-time cleanup", async () => {
  vi.spyOn(vaultStore, "recoveryCodes").mockResolvedValue({
    codes: ["aaaa-bbbb", "cccc-dddd"],
    used: [false, true],
    since: "2026-11-01T00:00:00Z",
  });
  render(<RecoveryCeremony busy={false} run={async (action) => action()} />);
  await screen.findByText("aaaa-bbbb");
  await clickCopy("Copy");
  expect(contents).toContain("aaaa-bbbb");
  expect(contents).not.toContain("cccc-dddd");
  await lockClear();
  expect(contents).toBe("");
});

it("routes a vault authenticator seed through lock-time cleanup", async () => {
  vi.spyOn(vaultStore, "beginTotpEnrollment").mockResolvedValue(
    "otpauth://totp/vault?secret=ABCDEFGH",
  );
  vi.spyOn(vaultStore, "cancelTotpEnrollment").mockImplementation(() => {});
  render(
    <AuthenticatorCeremony
      view="add"
      enrolled={["password"]}
      host={{ ok: true, hostname: "localhost", reason: "", fixUrl: null }}
      busy={false}
      run={async (action) => action()}
      onDone={() => {}}
    />,
  );
  const manual = await screen.findByRole("button", {
    name: "Can't scan? Type the key instead",
  });
  fireEvent.click(manual);
  await clickCopy("Copy setup key");
  expect(contents).toBe("ABCDEFGH");
  await lockClear();
  expect(contents).toBe("");
});

it.each([
  "../../sections/connections/secret-backends/SecretBackendItemFields.tsx",
  "../../sections/connections/tailscale/TailscaleDevicePanel.tsx",
  "../../sections/settings/plugins/HoneyTokensPanel.tsx",
  "../../sections/settings/security/AccountTotpCeremony.tsx",
  "../../sections/settings/security/DeadmanPanelView.tsx",
  "../../sections/settings/security/SecondStepCeremonies.tsx",
  "../../sections/vault/EnvironmentFields.tsx",
])(
  "keeps classified secret copy surface %s on the shared coordinator",
  (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toContain("useCopySecret");
    expect(source).not.toMatch(
      /navigator\s*(?:\.\s*clipboard|\[\s*["']clipboard["']\s*\])|\bcopyTextBestEffort\b|\.execCommand\(\s*["']copy["']/,
    );
  },
);
