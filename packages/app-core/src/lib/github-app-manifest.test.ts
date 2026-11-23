import { webcrypto } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPhysicalVaultPorts } from "../browser/physical-vault-ports.js";
import { configureHost } from "../host.js";
import { localStore, maybePage, sessionStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { atRestReady } from "./at-rest/key.js";
import { memoryStorage as memoryStorageFixture } from "./browser-reset.fixture.js";
import { applyConnectCallbackBase } from "./connect-callback.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { hasAuthResponse } from "./federation.js";
import {
  allowGithub,
  openGithubTestOwner,
} from "./github-app-authority.test-support.js";
import { updateGuestGithubAppMetadata } from "./github-app-guest.js";
import { retryPendingGuestGithubClaim } from "./github-app-guest-pending.js";
import {
  ensureGuestGithubAppLoaded,
  rememberLocalGithubApp,
} from "./github-app-local.js";
import {
  buildGithubAppRegistration,
  claimGithubAppCode,
  forgetLocalGithubApp,
  githubAppRedirectUrl,
  readLocalGithubApp,
  refreshGithubAppInstallations,
} from "./github-app-manifest.js";
import {
  hasPendingGithubAppSecret,
  pemFromVault,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { startGithubRegistration } from "./github-app-vault-transport.js";
import { listNotices } from "./notices.js";
import { type VaultState, vaultStore } from "./vault/store.js";
import { vfsFlush, vfsSeams } from "./vfs.js";

describe("GitHub static callback", () => {
  afterEach(async () => {
    applyConnectCallbackBase("");
    await forgetLocalGithubApp();
    vi.restoreAllMocks();
  });
  it.each([
    "http://localhost:5180",
    "https://opensesame-labs.github.io",
    "https://opensesame.vercel.app",
  ])(
    "returns to the same static app beneath its base path (%s)",
    async (origin) => {
      applyConnectCallbackBase("https://foreign-relay.example");
      const returnTo = `${origin}/OpenSesame/settings/connections/github?keep=yes`;
      const registration = await buildGithubAppRegistration({
        returnTo,
        origin,
      });
      expect(registration.redirectUrl).toBe(`${returnTo}&github_app=claim`);
      expect(registration.manifest.callback_urls).toEqual([
        registration.redirectUrl,
      ]);
      expect(registration.manifest.setup_url).toBe(
        `${returnTo}&github_app=installed`,
      );
      expect(
        hasAuthResponse(
          `?github_app=claim&code=manifest-code&state=${registration.state}`,
        ),
      ).toBe(false);
      expect(
        JSON.parse(
          sessionStore().getItem("opensesame.github-app.registration") ??
            "null",
        ),
      ).toMatchObject({
        state: registration.state,
        returnUrl: registration.redirectUrl,
      });
    },
  );
  it("rejects foreign, non-HTTP, credentialed and fragment callbacks before starting a transaction", () => {
    for (const returnTo of [
      "https://foreign.example/settings/connections/github",
      "javascript:alert(1)",
      "https://person:password@app.example/settings/connections/github",
      "https://app.example/settings/connections/github#code",
    ])
      expect(() =>
        githubAppRedirectUrl(returnTo, "https://app.example"),
      ).toThrow();
  });
  it("removes stale OAuth parameters and preserves an ordinary return query", () => {
    expect(
      githubAppRedirectUrl(
        "https://app.example/OpenSesame/settings/connections/github?keep=yes&code=old&state=old&error=bad",
        "https://app.example",
      ),
    ).toBe(
      "https://app.example/OpenSesame/settings/connections/github?keep=yes&github_app=claim",
    );
  });
});

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
const PUBLIC_RECORD = JSON.stringify({
  id: "4997182",
  key: "github-oauth",
  displayName: "OpenSesame Local",
  htmlUrl: "https://github.com/apps/opensesame-local",
  ownerLogin: "Tyler-R-Kendrick",
  ownerType: "User",
  installedByLogin: null,
  installations: [],
});

function vaultAs(overrides: Partial<VaultState>): void {
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    items: [],
    folders: [],
    ...overrides,
  });
}

async function nativeApi() {
  await startGithubRegistration(
    "claim-state",
    maybePage()?.location.href ??
      "https://app.example/settings/connections/github?github_app=claim",
  );
  const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/app-manifests/")) {
      return Response.json({
        id: 4997182,
        slug: "opensesame-local",
        client_id: "Iv1.example",
        name: "OpenSesame Local",
        html_url: "https://github.com/apps/opensesame-local",
        client_secret: "client-secret",
        pem: PEM,
        owner: { login: "Tyler-R-Kendrick", type: "User" },
      });
    }
    return Response.json({
      ownerLogin: "Tyler-R-Kendrick",
      ownerType: "User",
      installations: [
        { id: "1", accountLogin: "Tyler-R-Kendrick", accountType: "User" },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function storedValues(...stores: { map: Map<string, string> }[]): string[] {
  const out: string[] = [];
  for (const store of stores) {
    for (const value of store.map.values()) out.push(value);
  }
  return out;
}

describe("github app secret never rests in web storage", () => {
  let local: ReturnType<typeof memoryStorageFixture>;
  let session: ReturnType<typeof memoryStorageFixture>;
  let locks: ReturnType<typeof webLocksDouble>;

  beforeEach(() => {
    local = memoryStorageFixture();
    session = memoryStorageFixture();
    locks = webLocksDouble();
    configureHost(createTestHost({ storage: { local, session }, locks }));
    allowGithub();
    vi.stubGlobal("crypto", webcrypto);
  });

  afterEach(async () => {
    await forgetLocalGithubApp();
    vaultStore.lock();
    await vfsFlush();
    configureHost(createTestHost());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a guest's claimed key out of every storage key", async () => {
    vaultStore.lock();
    await vaultStore.createGuest();
    await expect(nativeApi()).rejects.toThrow(/protect this vault/i);
    // A protected guest can use the same-tab registration flow.
    const root = makeOpfs();
    configureHost(
      createTestHost({
        storage: { local, session },
        locks,
        ...createBrowserPhysicalVaultPorts(),
        originFiles: async () => overlapCast(root),
      }),
    );
    await atRestReady();
    await vaultStore.enrollPin("48291037");
    await nativeApi();
    const guarded = vfsSeams.writeRawGuarded;
    if (!guarded) throw new Error("Missing guarded VFS write");
    const configWrite = vi
      .spyOn(vfsSeams, "writeRawGuarded")
      .mockImplementation(async (key, ...args) => {
        if (key.endsWith("/config/guest-github-app"))
          throw new Error("metadata unavailable");
        return guarded(key, ...args);
      });
    await expect(claimGithubAppCode("gh-code", "claim-state")).resolves.toBe(
      "registered",
    );
    configWrite.mockRestore();
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
    expect(hasPendingGithubAppSecret("4997182")).toBe(false);
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "secret" && item.value.includes("PRIVATE KEY"),
        ),
    ).toBe(true);
    const tomb = vaultStore.activeTomb();
    const registered = readLocalGithubApp();
    if (!registered) throw new Error("Missing registered App");
    const verified = {
      ...registered,
      installations: [
        { id: "1", accountLogin: "example", accountType: "User" },
      ],
    };
    await updateGuestGithubAppMetadata(verified, () => {});
    rememberLocalGithubApp(verified);
    configureHost(createTestHost({ storage: { local, session }, locks }));
    vaultStore.lock();
    await vfsFlush();
    vaultStore.prepareGuestUnlock(tomb);
    await vaultStore.unlockWithPin("48291037");
    const refresh = vfsSeams.refreshRaw;
    let fail = true;
    if (!refresh) throw new Error("Missing VFS refresh");
    vi.spyOn(vfsSeams, "refreshRaw").mockImplementation(
      async (key, limit, check) => {
        if (key.endsWith("/config/guest-github-app") && fail) {
          fail = false;
          throw new Error("Temporary storage failure");
        }
        return refresh(key, limit, check);
      },
    );
    await expect(ensureGuestGithubAppLoaded()).rejects.toThrow(
      "Temporary storage failure",
    );
    expect(fail).toBe(false);
    await ensureGuestGithubAppLoaded();
    await vi.waitFor(() => expect(readLocalGithubApp()?.id).toBe("4997182"));
    const app = readLocalGithubApp();
    expect(app && pemFromVault(app)).toContain("PRIVATE KEY");
    expect(app?.installations).toEqual(verified.installations);
  });

  it("keeps a locked device's claimed key out of every storage key", async () => {
    vaultAs({ status: "locked", tomb: "personal", guest: false });
    const fetchMock = await nativeApi();
    await expect(claimGithubAppCode("gh-code", "claim-state")).resolves.toBe(
      "registered",
    );
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
    // Locked: nothing posts the key anywhere.
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
    }
  });

  it("can retry saving a converted guest App after the first vault write fails", async () => {
    vaultStore.lock();
    await vaultStore.createGuest();
    const root = makeOpfs();
    configureHost(
      createTestHost({
        storage: { local, session },
        locks,
        ...createBrowserPhysicalVaultPorts(),
        originFiles: async () => overlapCast(root),
      }),
    );
    await atRestReady();
    await vaultStore.enrollPin("48291037");
    await nativeApi();
    const save = vaultStore.saveItems.bind(vaultStore);
    let fail = true;
    vi.spyOn(vaultStore, "saveItems").mockImplementation(async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("storage unavailable");
      }
      return save(...args);
    });
    expect(await claimGithubAppCode("gh-code", "claim-state")).toBe("failed");
    expect(
      listNotices().some((notice) => notice.id === "github-app.guest-save"),
    ).toBe(true);
    await retryPendingGuestGithubClaim();
    const app = readLocalGithubApp();
    expect(app?.id).toBe("4997182");
    expect(app && pemFromVault(app)).toContain("PRIVATE KEY");
    expect(
      listNotices().some((notice) => notice.id === "github-app.guest-save"),
    ).toBe(false);
  });

  it("seals into an open vault and drops the memory copy at once", async () => {
    await openGithubTestOwner();
    vaultAs({ status: "unlocked", tomb: "personal", guest: false });
    const addItems = vi
      .spyOn(vaultStore, "saveItems")
      .mockResolvedValue(undefined);
    await nativeApi();
    await claimGithubAppCode("gh-code", "claim-state");
    expect(addItems).toHaveBeenCalledTimes(1);
    const [sealed] = addItems.mock.calls[0]?.[0] ?? [];
    expect(sealed?.kind).toBe("secret");
    expect(sealed?.kind === "secret" ? sealed.value : "").toContain(PEM);
    expect(hasPendingGithubAppSecret("4997182")).toBe(false);
    expect(
      JSON.parse(
        localStore().getItem("opensesame.github-app.secret-item") ?? "{}",
      ),
    ).toEqual({ appId: "4997182", itemId: sealed?.id });
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
  });

  it("removes the legacy cleartext key on first read", () => {
    localStore().setItem("opensesame.github-app.public", PUBLIC_RECORD);
    localStore().setItem("opensesame.github-app.pending-pem", PEM);
    sessionStore().setItem("opensesame.github-app.pending-pem", PEM);
    expect(readLocalGithubApp()?.id).toBe("4997182");
    expect(
      localStore().getItem("opensesame.github-app.pending-pem"),
    ).toBeNull();
    expect(
      sessionStore().getItem("opensesame.github-app.pending-pem"),
    ).toBeNull();
    expect(hasPendingGithubAppSecret("4997182")).toBe(true);
  });

  it("keeps the local App when GitHub rejects a just-claimed key", async () => {
    localStore().setItem("opensesame.github-app.public", PUBLIC_RECORD);
    vaultAs({ status: "unlocked", tomb: "personal", guest: false });
    stashPendingGithubAppSecret(
      { id: "4997182", displayName: "OpenSesame Local" },
      PEM,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "list_failed" }, { status: 401 }),
      ),
    );
    await expect(refreshGithubAppInstallations()).resolves.not.toBeNull();
    expect(local.getItem("opensesame.github-app.public")).not.toBeNull();
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
  });
});
