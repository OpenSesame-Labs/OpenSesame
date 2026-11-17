import { createPasskeySeam } from "@opensesame/auth-upstream";
import { createEventSealer } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { durablePasskeyCredentials } from "../repos/durable-passkey-store.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("rejects a stale verification across durable store instances", async () => {
  const client = await migratedPGlite();
  try {
    const db = overlapCast(drizzle(client, { schema }));
    const sealer = createEventSealer("durable-security-fixture-key");
    let signalStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = createPasskeySeam({
      credentialStore: durablePasskeyCredentials(db, sealer),
      verifyAssertion: async () => {
        signalStarted();
        await finished;
        return { ok: true, newCounter: 1 };
      },
    });
    const second = createPasskeySeam({
      credentialStore: durablePasskeyCredentials(db, sealer),
    });
    const credential = {
      credentialId: "key",
      publicKey: new Uint8Array([1]),
      counter: 0,
    };
    await first.register("alice", credential);
    const pending = first.verify({
      credentialId: "key",
      clientDataJSON: new Uint8Array(),
      authenticatorData: new Uint8Array(),
      signature: new Uint8Array(),
    });
    await started;
    expect(await second.remove("alice", "key")).toBe(true);
    await second.register("bob", credential);
    finish();
    expect(await pending).toEqual({ ok: false });
    expect((await second.list("bob"))[0]?.counter).toBe(0);
    expect(await first.remove("alice", "key")).toBe(false);
    expect(await second.list("bob")).toHaveLength(1);
  } finally {
    await client.close();
  }
});
