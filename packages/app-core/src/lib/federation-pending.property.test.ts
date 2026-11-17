/** @vitest-environment jsdom */
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { localStore, sessionStore } from "../ports.js";
import {
  PENDING_MAX_AGE_MS,
  PKCE_KEY,
  clearPendingSignIn,
  storePending,
  takeMatchingPending,
} from "./federation-pending.js";

type State = "state-alpha" | "state-bravo";
type RecordValue = { state: State; createdAt: number } | "corrupt" | null;
type World = { now: number; local: RecordValue; session: RecordValue };
type Action =
  | "store-alpha"
  | "store-bravo"
  | "session-alpha"
  | "session-bravo"
  | "corrupt"
  | "corrupt-session"
  | "expire"
  | "logout"
  | "take-alpha"
  | "take-bravo"
  | "take-none";

const states = { alpha: "state-alpha", bravo: "state-bravo" } as const;
const actions = fc.constantFrom<Action>(
  "store-alpha",
  "store-bravo",
  "session-alpha",
  "session-bravo",
  "corrupt",
  "corrupt-session",
  "expire",
  "logout",
  "take-alpha",
  "take-bravo",
  "take-none",
);

function record(state: State, createdAt: number) {
  return {
    upstreamId: "example",
    issuer: "https://issuer.example",
    verifier: "v".repeat(43),
    state,
    tokenEndpoint: "https://issuer.example/token",
    jwksUri: "https://issuer.example/jwks",
    scope: "openid",
    createdAt,
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

function observed(store: ReturnType<typeof localStore>): RecordValue {
  const raw = store.getItem(PKCE_KEY);
  if (raw === null) return null;
  if (raw === "{") return "corrupt";
  // SAFETY: this test writes only fixture records or the malformed sentinel above.
  const value = JSON.parse(raw) as { state: State; createdAt: number };
  return { state: value.state, createdAt: value.createdAt };
}

function save(world: World, lane: "local" | "session", state: State): void {
  const value = record(state, world.now);
  if (lane === "local") {
    storePending(value);
    world.local = { state, createdAt: world.now };
    world.session = null;
  } else {
    sessionStore().setItem(PKCE_KEY, JSON.stringify(value));
    world.session = { state, createdAt: world.now };
  }
}

function expectedTake(world: World, input: State | null) {
  const { local, session, now } = world;
  const conflict =
    local !== null &&
    local !== "corrupt" &&
    session !== null &&
    session !== "corrupt" &&
    local.state !== session.state;
  const chosen = local ?? session;
  if (conflict || chosen === "corrupt") return "stale";
  if (chosen === null) return "absent";
  if (now - chosen.createdAt > PENDING_MAX_AGE_MS) return "stale";
  return input === chosen.state ? "accepted" : "unmatched";
}

function take(world: World, input: State | null): void {
  const expected = expectedTake(world, input);
  const actual = takeMatchingPending(input);
  const outcome = actual.pending
    ? "accepted"
    : actual.stale
      ? "stale"
      : actual.unmatched
        ? "unmatched"
        : "absent";
  expect(outcome).toBe(expected);
  if (actual.pending) expect(actual.pending.state).toBe(input);
  if (expected === "accepted" || expected === "stale") {
    world.local = null;
    world.session = null;
  }
}

function applyAction(world: World, action: Action): void {
  switch (action) {
    case "store-alpha":
      save(world, "local", states.alpha);
      break;
    case "store-bravo":
      save(world, "local", states.bravo);
      break;
    case "session-alpha":
      save(world, "session", states.alpha);
      break;
    case "session-bravo":
      save(world, "session", states.bravo);
      break;
    case "corrupt":
      localStore().setItem(PKCE_KEY, "{");
      world.local = "corrupt";
      break;
    case "corrupt-session":
      sessionStore().setItem(PKCE_KEY, "{");
      world.session = "corrupt";
      break;
    case "expire":
      world.now += PENDING_MAX_AGE_MS + 1;
      break;
    case "logout":
      clearPendingSignIn();
      world.local = null;
      world.session = null;
      break;
    case "take-alpha":
      take(world, states.alpha);
      break;
    case "take-bravo":
      take(world, states.bravo);
      break;
    case "take-none":
      take(world, null);
      break;
  }
  expect(observed(localStore())).toEqual(world.local);
  expect(observed(sessionStore())).toEqual(world.session);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves a live transaction for an unrelated response and consumes a matching response once", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  storePending(record(states.alpha, Date.now()));

  expect(takeMatchingPending(states.bravo)).toMatchObject({
    pending: null,
    stale: false,
    unmatched: true,
  });
  expect(takeMatchingPending(states.alpha).pending?.state).toBe(states.alpha);
  expect(takeMatchingPending(states.alpha)).toEqual({
    pending: null,
    stale: false,
  });
});

it("accepts the maximum age and rejects an older transaction", () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());

  storePending(record(states.alpha, now));
  now += PENDING_MAX_AGE_MS;
  expect(takeMatchingPending(states.alpha).pending?.state).toBe(states.alpha);

  storePending(record(states.alpha, now));
  now += PENDING_MAX_AGE_MS + 1;
  expect(takeMatchingPending(states.alpha)).toEqual({
    pending: null,
    stale: true,
  });
});

it("preserves correlation and consumes only the matching live legacy transaction", () => {
  let world: World = { now: 1_000_000, local: null, session: null };
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());

  fc.assert(
    fc.property(
      fc.array(actions, { minLength: 1, maxLength: 35 }),
      (sequence) => {
        world = { now: 1_000_000, local: null, session: null };
        localStore().removeItem(PKCE_KEY);
        sessionStore().removeItem(PKCE_KEY);
        for (const action of sequence) applyAction(world, action);
      },
    ),
    { seed: 20261116, numRuns: 300 },
  );
});
