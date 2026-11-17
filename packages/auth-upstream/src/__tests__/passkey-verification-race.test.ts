import { expect, it } from "vitest";
import type { PasskeyVerifyResult } from "../passkey.js";
import {
  createMemoryPasskeyCredentialStore,
  createPasskeySeam,
} from "../passkey.js";

const assertion = {
  credentialId: "shared-key",
  clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(),
  signature: new Uint8Array(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([{ ok: true, newCounter: 1 }, { ok: true, newCounter: 0 }, true])(
  "rejects verification after removal and replacement: %s",
  async (result) => {
    const started = deferred<void>();
    const finished = deferred<boolean | PasskeyVerifyResult>();
    const seam = createPasskeySeam({
      verifyAssertion: async () => {
        started.resolve();
        return finished.promise;
      },
    });
    const original = {
      credentialId: assertion.credentialId,
      publicKey: new Uint8Array([1]),
      counter: 0,
    };
    await seam.register("alice", original);
    const pending = seam.verify(assertion);
    await started.promise;
    expect(await seam.remove("alice", assertion.credentialId)).toBe(true);
    await seam.register("bob", { ...original, publicKey: new Uint8Array([2]) });
    finished.resolve(result);
    expect(await pending).toEqual({ ok: false });
    expect((await seam.list("bob"))[0]?.counter).toBe(0);
  },
);

it("rejects an old verification after the same owner re-registers the same key", async () => {
  const started = deferred<void>();
  const finished = deferred<boolean>();
  const seam = createPasskeySeam({
    verifyAssertion: async () => {
      started.resolve();
      return finished.promise;
    },
  });
  const credential = {
    credentialId: assertion.credentialId,
    publicKey: new Uint8Array([1]),
    counter: 0,
  };
  await seam.register("alice", credential);
  const pending = seam.verify(assertion);
  await started.promise;
  await seam.remove("alice", assertion.credentialId);
  await seam.register("alice", credential);
  finished.resolve(true);
  expect(await pending).toEqual({ ok: false });
});

it("does not expose mutable references to stored credentials", async () => {
  const seam = createPasskeySeam({ verifyAssertion: async () => true });
  const publicKey = new Uint8Array([1]);
  const registered = await seam.register("alice", {
    credentialId: assertion.credentialId,
    publicKey,
    counter: 0,
  });
  publicKey[0] = 9;
  registered.principalId = "bob";
  registered.publicKey[0] = 8;
  const listed = await seam.list("alice");
  expect(listed).toHaveLength(1);
  expect(listed[0]?.publicKey[0]).toBe(1);
  if (listed[0]) listed[0].principalId = "bob";
  expect(await seam.verify(assertion)).toEqual({
    ok: true,
    principalId: "alice",
  });
});

it("still verifies credentials stored before registration generations existed", async () => {
  const store = createMemoryPasskeyCredentialStore();
  await store.create({
    credentialId: assertion.credentialId,
    publicKey: new Uint8Array([1]),
    counter: 0,
    principalId: "alice",
  });
  const seam = createPasskeySeam({
    credentialStore: store,
    verifyAssertion: async () => ({ ok: true, newCounter: 1 }),
  });
  expect(await seam.verify(assertion)).toEqual({
    ok: true,
    principalId: "alice",
  });
});

it("uses the identity read before calling a verifier that mutates its input", async () => {
  const seam = createPasskeySeam({
    verifyAssertion: async (_, credential) => {
      credential.principalId = "bob";
      credential.credentialId = "different";
      credential.generation = "different";
      return true;
    },
  });
  await seam.register("alice", {
    credentialId: assertion.credentialId,
    publicKey: new Uint8Array([1]),
    counter: 0,
  });
  expect(await seam.verify(assertion)).toEqual({
    ok: true,
    principalId: "alice",
  });
});
