import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { forgetHeldWebStorageForTest } from "../at-rest/web-storage.js";
import { defaultCapabilityConnectors } from "../capabilities.js";
import { clearHostSession, clearSession } from "../identity.js";
import {
  IDENTITY_REVOCATION_PREFIX,
  forgetRevocationMemoryForTest,
} from "../identity-revocation-journal.js";
import { resetSharedSignOutForTest } from "../identity-shared-signout.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { saveSettings } from "../settings.js";
import { HOST, IDENTITY } from "./identity-session-support.js";
import { loopbackProfileEligible } from "./loopback-profile.js";
import { webLocksDouble } from "./web-locks-double.js";

const networkEligible = localNetworkFetchSeams.eligible;

/** A clean browser with the loopback Identity service configured. */
export function freshSignOutBrowser(
  overrides: Parameters<typeof createTestHost>[0] = {},
): void {
  localStorage.clear();
  sessionStorage.clear();
  forgetAtRestKeyForTest();
  forgetHeldWebStorageForTest();
  forgetRevocationMemoryForTest();
  resetSharedSignOutForTest();
  configureHost(createTestHost({ locks: webLocksDouble(), ...overrides }));
  localNetworkFetchSeams.eligible = loopbackProfileEligible;
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

export function restoreSignOutBrowser(): void {
  localNetworkFetchSeams.eligible = networkEligible;
  clearSession();
  clearHostSession();
  forgetRevocationMemoryForTest();
  resetSharedSignOutForTest();
  localStorage.clear();
  sessionStorage.clear();
  configureHost(createTestHost());
}

/** The physical keys of owed revokes, as another document would see them. */
export function journalKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(IDENTITY_REVOCATION_PREFIX)) keys.push(key);
  }
  return keys;
}
