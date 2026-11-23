/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionStore } from "../ports.js";
import {
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import {
  freshSignOutBrowser,
  restoreSignOutBrowser,
} from "./__tests__/identity-signout-support.js";
import { advanceAuthGeneration } from "./auth-generation.js";
import {
  connectProvisional,
  currentSession,
  identitySessionEpoch,
  rebindSession,
  restoreSession,
  settleRevokes,
  subscribeIdentitySession,
} from "./identity.js";
import {
  assertSignOutEpoch,
  captureSignOutEpoch,
} from "./identity-shared-signout.js";
import { beginMagicLink, completeMagicLink } from "./magic-link-client.js";

const ME = `${IDENTITY}/v1/principals/me`;
const REVOKE = `${IDENTITY}/v1/principals/provisional/revoke`;
const issuerOrigin = new URL(IDENTITY).origin;

beforeEach(() => freshSignOutBrowser());
afterEach(async () => {
  await settleRevokes();
  vi.unstubAllGlobals();
  restoreSignOutBrowser();
});

/** What another tab's sign-out leaves in the shared, sealed store. */
const anotherTabSignsOut = () => advanceAuthGeneration();

function revokedBearers(fetcher: ReturnType<typeof stubFetch>): string[] {
  return fetcher.mock.calls
    .filter(([url]) => String(url) === REVOKE)
    .map(([, init]) => new Headers(init?.headers).get("authorization") ?? "");
}

function bearerSession(accessToken = "federated_tok") {
  return {
    principalId: "principal_1",
    accessToken,
    issuerOrigin,
    issuerBase: IDENTITY,
  };
}

it("retires an open session and revokes its bearer when another tab signs out", async () => {
  const fetcher = stubBasic();
  restoreSession(bearerSession());
  expect(currentSession()?.accessToken).toBe("federated_tok");
  anotherTabSignsOut();
  expect(currentSession()).toBeNull();
  await settleRevokes();
  expect(revokedBearers(fetcher)).toEqual(["Bearer federated_tok"]);
});

it("wakes a quiet tab when another tab announces its sign-out", async () => {
  stubBasic();
  restoreSession(bearerSession());
  const heard = vi.fn();
  const unsubscribe = subscribeIdentitySession(heard);
  anotherTabSignsOut();
  const other = new BroadcastChannel("opensesame.identity-signout.v1");
  try {
    other.postMessage({ type: "signed-out" });
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());
    expect(currentSession()).toBeNull();
  } finally {
    other.close();
    unsubscribe();
  }
});

it("refuses an OIDC or federation restore that lands after another tab signs out", async () => {
  const fetcher = stubBasic();
  const epoch = identitySessionEpoch();
  anotherTabSignsOut();
  expect(() =>
    restoreSession(bearerSession("late_tok"), epoch, IDENTITY),
  ).toThrow(/ended while finishing sign-in/i);
  expect(currentSession()).toBeNull();
  await settleRevokes();
  expect(revokedBearers(fetcher)).toEqual(["Bearer late_tok"]);
});

it("refuses a rebind whose link was in flight when another tab signed out", async () => {
  const fetcher = stubBasic((url, init) => {
    const bearer = new Headers(init?.headers).get("authorization");
    if (url === ME && bearer === "Bearer rebound_tok")
      return jsonResponse({ id: "principal_2" });
    return undefined;
  });
  const epoch = identitySessionEpoch();
  anotherTabSignsOut();
  await expect(rebindSession("rebound_tok", epoch, IDENTITY)).rejects.toThrow(
    /ended while adopting/i,
  );
  expect(currentSession()).toBeNull();
  await settleRevokes();
  expect(revokedBearers(fetcher)).toContain("Bearer rebound_tok");
});

it("does not publish a provisional session minted while another tab signed out", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let minting = () => {};
  const begun = new Promise<void>((resolve) => {
    minting = resolve;
  });
  const fetcher = stubFetch(async (url) => {
    if (url === ME) return jsonResponse({}, 401);
    if (url === REVOKE) return new Response(null, { status: 204 });
    if (url === `${IDENTITY}/v1/principals/provisional`) {
      minting();
      await gate;
      return jsonResponse(provisionalBody("raced_tok"));
    }
    return jsonResponse({}, 500);
  });
  const connecting = connectProvisional();
  await begun;
  anotherTabSignsOut();
  release();
  await expect(connecting).rejects.toThrow(/ended while connecting/i);
  expect(currentSession()).toBeNull();
  await settleRevokes();
  expect(revokedBearers(fetcher)).toContain("Bearer raced_tok");
});

it("refuses a magic-link return after any tab signed out, revoking what it issued", async () => {
  const handoff = await beginMagicLink("person@example.test");
  handoff.commit();
  const state = JSON.parse(
    sessionStore().getItem("opensesame.magic-link.pending.v1") ?? "{}",
  ).state;
  anotherTabSignsOut();
  const fetcher = stubBasic((url) =>
    url.endsWith("/v1/auth/magic-link/exchange")
      ? jsonResponse({ principalId: "principal_1", accessToken: "link_tok" })
      : undefined,
  );
  await expect(completeMagicLink("code", state, () => {})).rejects.toThrow(
    /signed out/i,
  );
  expect(currentSession()).toBeNull();
  await settleRevokes();
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).endsWith("/magic-link/exchange"),
    ),
  ).toBe(false);
});

it("lets guest code fence its own work to the durable sign-out epoch", () => {
  const epoch = captureSignOutEpoch();
  expect(() => assertSignOutEpoch(epoch)).not.toThrow();
  anotherTabSignsOut();
  expect(() => assertSignOutEpoch(epoch)).toThrow(/signed out/i);
  expect(() => assertSignOutEpoch(null)).toThrow(/signed out/i);
});
