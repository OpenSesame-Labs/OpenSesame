/** @vitest-environment jsdom */
/**
 * AUTH-C1 and GUEST-V1 correspondence: every vector GuestContract.lean prints
 * is replayed against the real implementation through its test seams.
 */
import { readFileSync } from "node:fs";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../../packages/app-core/src/host.js";
import {
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubFetch,
} from "../../../packages/app-core/src/lib/__tests__/identity-session-support.js";
import { webLocksDouble } from "../../../packages/app-core/src/lib/__tests__/web-locks-double.js";
import { advanceAuthGeneration } from "../../../packages/app-core/src/lib/auth-generation.js";
import {
  beginBrowserPairing,
  browserPairingSeams,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
  pollBrowserPairing,
} from "../../../packages/app-core/src/lib/browser-pairing.js";
import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
  continueAsGuest,
  guestAuthDependencies,
} from "../../../packages/app-core/src/lib/guest-auth.js";
import {
  activateGuestTomb,
  retireGuestTomb,
} from "../../../packages/app-core/src/lib/guest-session-context.js";
import { newGuestVaultId } from "../../../packages/app-core/src/lib/guest-vault-id.js";
import {
  clearSession,
  connectFreshProvisional,
  currentSession,
  endSession,
  settleRevokes,
} from "../../../packages/app-core/src/lib/identity.js";
import {
  assertSignOutEpoch,
  captureSignOutEpoch,
} from "../../../packages/app-core/src/lib/identity-shared-signout.js";
import { kvGet } from "../../../packages/app-core/src/lib/kv.js";
import * as localDirectory from "../../../packages/app-core/src/lib/local-directory.js";
import { clearGuestSessionPerson } from "../../../packages/app-core/src/lib/local-guest.js";
import { localNetworkFetchSeams } from "../../../packages/app-core/src/lib/local-network-fetch.js";
import {
  loadSettings,
  saveSettings,
} from "../../../packages/app-core/src/lib/settings.js";
import * as vfs from "../../../packages/app-core/src/lib/vfs.js";
import { sessionStore } from "../../../packages/app-core/src/ports.js";
import { createTestHost } from "../../../packages/app-core/src/test-host.js";

const vectors = process.env.OPENSESAME_GUEST_FORMAL_VECTORS;
if (!vectors)
  throw new Error("Run spec/formal/guest/verify.sh for Lean vectors");
const rows = readFileSync(vectors, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const group = (kind: string) =>
  rows.filter((row) => row[0] === kind).map((row) => row.slice(1));
const flag = (value: string) => value === "1";
const binary = [() => "1", () => "0"] as const;
const settleOf = <T>(work: Promise<T>) => work.then(...binary);
const ended = "The session was ended while connecting. Connect again.";
const outcome = ({ message }: Error) => {
  if (message === FRESH_GUEST_SIGN_OUT_MESSAGE || message === ended)
    return "signOut";
  if (message === FRESH_GUEST_STATUS_UNKNOWN_MESSAGE) return "unknown";
  throw new Error(message);
};

/** A local store whose reads and writes can be refused, or whose writes lost. */
class FlakyStorage extends Map<string, string> {
  mode: "ok" | "refuse" | "lostWrite" = "ok";
  key = (index: number) => [...this.keys()][index] ?? null;
  getItem = (key: string) => this.refused() ?? this.get(key) ?? null;
  setItem = (key: string, value: string) => {
    this.refused();
    if (this.mode === "lostWrite") throw new Error("quota");
    this.set(key, value);
  };
  removeItem = (key: string) => this.delete(key);
  get length() {
    return this.size;
  }
  private refused(): null {
    if (this.mode === "refuse") throw new Error("storage refused");
    return null;
  }
}

afterEach(() => {
  configureHost(createTestHost());
  vi.unstubAllGlobals();
});
it("admission: continueAsGuest agrees with `admit` on every case", async () => {
  const cases = group("admission");
  expect(cases).toHaveLength(2 * 3 * 24 ** 3);
  const original = { ...guestAuthDependencies };
  let row: string[] = [];
  let phase = 2;
  let created = false;
  const seen = () => row[phase] ?? "";
  // SAFETY: a fixture lock seam; mintGuestSessionPersonLocked only calls request(name, task).
  const locks = {
    request: async <T>(_name: string, task: () => Promise<T>) => {
      phase = 4;
      return task();
    },
  } as never;
  configureHost(createTestHost({ locks }));
  Object.assign(guestAuthDependencies, {
    isRemoteIdentityConfigured: () => flag(row[0] ?? ""),
    currentSession: () => {
      const sess = seen().slice(0, -3);
      if (sess === "none") return null;
      return { principalId: sess === "own" ? "prn_minted" : "prn_other" };
    },
    loadFederationSession: () => (flag(seen().at(-3) ?? "") ? {} : null),
    hasHostSession: () => flag(seen().at(-2) ?? ""),
    hasHiddenIdentitySession: () => flag(seen().at(-1) ?? ""),
    connectFreshProvisional: async () => {
      if (row[1] === "signOut") throw new Error(FRESH_GUEST_SIGN_OUT_MESSAGE);
      if (row[1] === "unknown")
        throw new Error(FRESH_GUEST_STATUS_UNKNOWN_MESSAGE);
      phase = 3;
      return { principalId: "prn_minted" };
    },
    connectProvisional: async () => ({ principalId: "prn_minted" }),
    createGuest: async () => {
      created = true;
    },
  });
  try {
    for (const next of cases) {
      row = next;
      phase = 2;
      created = false;
      clearGuestSessionPerson();
      const actual = await continueAsGuest().then(() => "ok", outcome);
      expect([...row.slice(0, 5), actual]).toEqual(row);
      expect(created).toBe(actual === "ok");
    }
  } finally {
    Object.assign(guestAuthDependencies, original);
    clearGuestSessionPerson();
  }
});
it("fresh mint: connectFreshProvisional agrees with `connectFresh`", async () => {
  const cases = group("fresh");
  expect(cases).toHaveLength(18);
  localNetworkFetchSeams.eligible = () => true;
  saveSettings({ ...loadSettings(), identityApi: IDENTITY });
  for (const [before, signedOut, after, ...expected] of cases) {
    let minted = false;
    let revoked = false;
    let probe = before;
    stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        if (probe === "absent") return jsonResponse({}, 401);
        if (probe === "present") return jsonResponse({ id: "prn_member" });
        return jsonResponse({}, 503);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        minted = true;
        if (flag(signedOut ?? "")) advanceAuthGeneration();
        probe = after;
        return jsonResponse(provisionalBody("guest-token"));
      }
      if (url.endsWith("/v1/principals/provisional/revoke")) {
        const bearer = new Headers(init?.headers).get("authorization");
        revoked ||= bearer === "Bearer guest-token";
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    });
    const actual = await connectFreshProvisional().then(
      (session) => (session.accessToken === "guest-token" ? "ok" : "other"),
      outcome,
    );
    const adopted = currentSession()?.accessToken === "guest-token";
    await settleRevokes();
    expect([actual, minted ? "1" : "0", revoked ? "1" : "0"]).toEqual(expected);
    expect(adopted).toBe(actual === "ok");
    probe = "absent";
    endSession();
    await settleRevokes();
    clearSession();
    sessionStore().removeItem("opensesame.guest.identity-isolated");
  }
});
it("pairing: pairedHostFetch sends a grant only after clear boundaries", async () => {
  const cases = group("pairing");
  expect(cases).toHaveLength(8 + 32);
  const host = "http://127.0.0.1:8787";
  const original = { ...browserPairingSeams };
  let states: boolean[] = [];
  let sent = 0;
  const step = () => {
    if (states.shift()) activateGuestTomb("guest_formal", null);
    else retireGuestTomb("guest_formal");
  };
  browserPairingSeams.eligible = () => true;
  localNetworkFetchSeams.eligible = () => true;
  browserPairingSeams.createKey = async () => ({
    createDpopProof: async () => {
      step();
      return "proof";
    },
    jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
  let retry = false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/browser-pairings"))
      return jsonResponse({
        pairing_id: "pairing-1",
        device_code: "d".repeat(40),
        user_code: "ABCD-1234",
        verification_uri: `${host}/pair`,
        expires_in: 300,
        interval: 5,
      });
    if (url.endsWith("/token"))
      return jsonResponse({
        access_token: "formal-opaque-credential-with-at-least-32-bytes",
        token_type: "DPoP",
        expires_in: 300,
        client_id: "client-1",
        scope: "host.sync.read host.sync.write",
      });
    if (new Headers(init?.headers).get("authorization")?.startsWith("DPoP "))
      sent += 1;
    step();
    const nonce = retry && sent === 1;
    return new Response("{}", {
      status: nonce ? 401 : 200,
      headers: nonce ? { "DPoP-Nonce": "n" } : {},
    });
  });
  try {
    for (const [r, bits, sends, completes] of cases) {
      retireGuestTomb("guest_formal");
      states = [];
      await beginBrowserPairing(host);
      await pollBrowserPairing();
      expect(currentBrowserGrant(host)).not.toBeNull();
      activateGuestTomb("guest_formal", null);
      expect(currentBrowserGrant(host)).toBeNull();
      retry = flag(r ?? "");
      sent = 0;
      states = [...(bits ?? "")].map(flag);
      step();
      const done = await pairedHostFetch(host, "/api/v1/sync/pull-page").then(
        () => "1",
        () => "0",
      );
      expect([String(sent), done]).toEqual([sends, completes]);
    }
  } finally {
    retireGuestTomb("guest_formal");
    clearBrowserPairing();
    Object.assign(browserPairingSeams, original);
  }
});
it("epoch: assertSignOutEpoch agrees with `epochHolds`", () => {
  const cases = group("epoch");
  expect(cases).toHaveLength(12);
  for (const [start, mid, holds] of cases) {
    const local = new FlakyStorage();
    // SAFETY: FlakyStorage implements the Storage members the sealed store reads.
    const storage = { local: local as never };
    configureHost(createTestHost({ storage }));
    if (start === "gen 3") for (let n = 0; n < 3; n++) advanceAuthGeneration();
    if (start === "refusing") local.mode = "refuse";
    const captured = captureSignOutEpoch();
    if (mid === "signOut") advanceAuthGeneration();
    if (mid === "lostWrite") {
      local.mode = "lostWrite";
      advanceAuthGeneration();
      local.mode = "ok";
    }
    if (mid === "refuse") local.mode = "refuse";
    let actual = "1";
    try {
      assertSignOutEpoch(captured);
    } catch {
      actual = "0";
    }
    expect(actual).toBe(holds);
  }
});
it("transient guest: the store agrees with `tstep` on every three-step trace", async () => {
  const cases = group("transient");
  expect(cases).toHaveLength(13 ** 3);
  const t = await import(
    "../../../packages/app-core/src/lib/vfs-transient-guest.js"
  );
  for (const [ops, expected] of cases) {
    const tomb = newGuestVaultId();
    const key = `tomb/${tomb}/k`;
    let own = Symbol("none");
    const results: string[] = [];
    for (const [index, op] of (ops ?? "").split(",").entries()) {
      const run = (): string => {
        if (op === "begin") own = t.beginTransientGuest(tomb);
        else if (op === "write") {
          const out = t.writeTransientGuest(key, String(index + 1));
          if (out === false) return "noStore";
          if (out instanceof Promise) {
            out.catch(() => undefined);
            return "deferred";
          }
        } else if (op === "freeze") t.freezeTransientGuest(tomb, own);
        else if (op === "freezeForeign") t.freezeTransientGuest(tomb, Symbol());
        else if (op === "thaw") t.thawTransientGuest(tomb, own);
        else if (op === "block") t.setTransientGuestBlocked(tomb, own, true);
        else if (op === "unblock") t.setTransientGuestBlocked(tomb, own, false);
        else if (op === "blockForeign")
          t.setTransientGuestBlocked(tomb, Symbol(), true);
        else if (op === "finish") t.endTransientGuest(tomb, own);
        else if (op === "release") t.releaseTransientGuest(tomb, own);
        else if (op === "releaseForeign")
          t.releaseTransientGuest(tomb, Symbol());
        else if (op === "discard")
          t.discardUnpublishedTransientGuest(tomb, own);
        else if (op === "releaseRetired") t.releaseRetiredTransientGuest(tomb);
        else throw new Error(`unknown op ${op}`);
        return "ok";
      };
      let result: string;
      try {
        result = run();
      } catch {
        result = "refused";
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const value = t.isTransientGuest(tomb) ? t.readTransientGuest(key) : null;
      results.push(`${result}:${value ?? "-"}`);
    }
    expect(`${ops}\t${results.join(",")}`).toBe(`${ops}\t${expected}`);
    if (t.isTransientGuest(tomb)) t.endTransientGuest(tomb, own);
    t.releaseRetiredTransientGuest(tomb);
  }
});
it("local directory reads agree with `readDir`; a refused read is never rewritten", async () => {
  const cases = group("local");
  expect(cases).toHaveLength(6);
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const encode = (text: string) => new TextEncoder().encode(text);
  const valid = { version: 2, revision: 4, entries: [], memberships: [] };
  for (const [stored, expected, writes] of cases) {
    const tomb = `formal-local-${crypto.randomUUID()}`;
    const first = await mintVaultKey();
    vfs.unlockTomb(tomb, first.vaultKey);
    const write = (bytes: Uint8Array) =>
      vfs.writeFile(tomb, localDirectory.LOCAL_DIRECTORY_PATH, bytes);
    if (stored === "valid" || stored === "otherKey")
      await write(encode(JSON.stringify(valid)));
    if (stored === "badJson") await write(encode("{"));
    if (stored === "badShape") await write(encode('{"version":2}'));
    if (stored === "oversize")
      await write(
        encode(JSON.stringify({ ...valid, pad: "x".repeat(512_001) })),
      );
    if (stored === "otherKey") {
      vfs.lockAllTombs();
      vfs.unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    }
    const key = vfs.tombFileKey(tomb, localDirectory.LOCAL_DIRECTORY_PATH);
    const raw = kvGet(key);
    const read = await localDirectory.readLocalDirectory(tomb).then(
      (dir) => (dir.revision === 4 ? "1" : "0"),
      () => "refused",
    );
    expect(read).toBe(expected);
    const commit = await settleOf(
      localDirectory.commitLocalDirectoryUnderLock(tomb, read === "1" ? 4 : 0, {
        action: "create",
        kind: "person",
        name: "Formal",
      }),
    );
    expect(commit).toBe(writes);
    if (read === "refused") expect(kvGet(key)).toBe(raw);
  }
});
