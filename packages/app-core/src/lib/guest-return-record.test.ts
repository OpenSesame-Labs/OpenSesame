/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import type { GuestContinuation } from "./guest-continuation.js";
import {
  consumeGuestReturn,
  issueGuestReturn,
  revokeGuestReturns,
} from "./guest-return-record.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { kvForgetAll } from "./kv.js";

let root: ReturnType<typeof makeOpfs>;
let value: GuestContinuation;
const check = () => {};

beforeEach(() => {
  root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  value = {
    kind: "vercel",
    token: crypto.randomUUID(),
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: "guest-person", name: "Guest" },
    origin: "https://app.example",
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  };
});
afterEach(() => {
  configureHost(createTestHost());
  kvForgetAll();
});

it("consumes a copied return once, including after the in-memory cache is lost", async () => {
  await issueGuestReturn(value, check);
  await consumeGuestReturn(value, check);
  kvForgetAll();
  await expect(consumeGuestReturn(value, check)).rejects.toThrow(/expired/i);
});

it("rejects a return if its durable issuance was removed or changed", async () => {
  await issueGuestReturn(value, check);
  await expect(
    consumeGuestReturn(
      { ...value, person: { ...value.person, id: "other" } },
      check,
    ),
  ).rejects.toThrow(/expired/i);
  root.files.clear();
  kvForgetAll();
  await expect(consumeGuestReturn(value, check)).rejects.toThrow(/expired/i);
});

it("rejects a return revoked by the original guest", async () => {
  await issueGuestReturn(value, check);
  await revokeGuestReturns(value.tomb);
  kvForgetAll();
  await expect(consumeGuestReturn(value, check)).rejects.toThrow(/expired/i);
});
