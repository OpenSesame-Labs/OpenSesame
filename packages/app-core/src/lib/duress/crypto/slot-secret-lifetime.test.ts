import { afterEach, expect, it, vi } from "vitest";
import { DURESS_PIN_PBKDF2_ITERATIONS } from "../keys/pin-floors.js";
import { importOwnedAes, pbkdf2, withSecretCopy } from "./slot-bytes.js";
import { sealPrfAndCode } from "./slot-prf.js";
import { openProfileSlot, sealProfileSlot } from "./slot-profile.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "clears an AES import and its owned input on failure=%s",
  async (fail) => {
    const raw = new Uint8Array(32).fill(7);
    const imported = vi.spyOn(crypto.subtle, "importKey");
    if (fail) imported.mockRejectedValue(new Error("import failed"));
    const result = importOwnedAes(raw);
    if (fail) await expect(result).rejects.toThrow("import failed");
    else expect((await result).type).toBe("secret");
    expect(raw).toEqual(new Uint8Array(32));
    expect(imported.mock.calls[0]?.[1]).toEqual(new Uint8Array(32));
  },
);

it.each([false, true])(
  "clears a borrowed copy without changing its caller on failure=%s",
  async (fail) => {
    const original = new Uint8Array([1, 2, 3]);
    let captured: Uint8Array | undefined;
    const result = withSecretCopy(original, async (copy) => {
      captured = copy;
      if (fail) throw new Error("failed");
      return copy[0];
    });
    if (fail) await expect(result).rejects.toThrow("failed");
    else await expect(result).resolves.toBe(1);
    expect(original).toEqual(new Uint8Array([1, 2, 3]));
    expect(captured).toEqual(new Uint8Array(3));
  },
);

it("clears encoded duress code when WebCrypto rejects its import", async () => {
  const imported = vi
    .spyOn(crypto.subtle, "importKey")
    .mockRejectedValue(new Error("failed"));
  await expect(
    pbkdf2("12345678", new Uint8Array(16), DURESS_PIN_PBKDF2_ITERATIONS),
  ).rejects.toThrow("failed");
  expect(imported.mock.calls[0]?.[1]).toEqual(new Uint8Array(8));
});

it("clears the sealed and opened slot buffers while retaining returned data", async () => {
  const key = new Uint8Array(32).fill(9);
  const context = {
    vaultRef: "v",
    deviceBindingRef: "d",
    policyRevision: 1,
    keyEpoch: 1,
  };
  const encrypted = vi.spyOn(crypto.subtle, "encrypt");
  const slot = await sealProfileSlot({
    code: "12345678",
    slotId: "s",
    profileId: "p",
    ...context,
    plaintext: {
      compartmentKey: key,
      actionCapability: null,
      presentation: "restricted",
    },
  });
  const body = encrypted.mock.calls[0]?.[2];
  if (!(body instanceof Uint8Array)) throw new Error("Expected slot bytes");
  expect(body).toEqual(new Uint8Array(body.length));
  expect(key).toEqual(new Uint8Array(32).fill(9));
  const decrypted = vi.spyOn(crypto.subtle, "decrypt");
  const opened = await openProfileSlot("12345678", slot, context);
  expect(opened?.compartmentKey).toEqual(key);
  const result = decrypted.mock.results[0]?.value;
  if (!result) throw new Error("Expected a decrypt call");
  const raw = new Uint8Array(await result);
  expect(raw).toEqual(new Uint8Array(raw.length));
});

it("clears the plaintext slot buffer when encryption fails", async () => {
  const encrypted = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockRejectedValue(new Error("failed"));
  const key = new Uint8Array(32).fill(9);
  await expect(
    sealProfileSlot({
      code: "12345678",
      slotId: "s",
      profileId: "p",
      vaultRef: "v",
      deviceBindingRef: "d",
      policyRevision: 1,
      keyEpoch: 1,
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "restricted",
      },
    }),
  ).rejects.toThrow("failed");
  const body = encrypted.mock.calls[0]?.[2];
  if (!(body instanceof Uint8Array)) throw new Error("Expected slot bytes");
  expect(body).toEqual(new Uint8Array(body.length));
  expect(key).toEqual(new Uint8Array(32).fill(9));
});

it("rejects malformed decrypted slot data and clears it", async () => {
  const context = {
    vaultRef: "v",
    deviceBindingRef: "d",
    policyRevision: 1,
    keyEpoch: 1,
  };
  const slot = await sealProfileSlot({
    code: "12345678",
    slotId: "s",
    profileId: "p",
    ...context,
    plaintext: {
      compartmentKey: new Uint8Array(32),
      actionCapability: null,
      presentation: "restricted",
    },
  });
  const malformed = new Uint8Array([0, 0, 0, 20, 5, 6]);
  vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(malformed.buffer);
  expect(await openProfileSlot("12345678", slot, context)).toBeNull();
  expect(malformed).toEqual(new Uint8Array(malformed.length));
});

it("clears PRF and plaintext snapshots without wiping caller-owned bytes", async () => {
  const prf = new Uint8Array(32).fill(4);
  const key = new Uint8Array(32).fill(8);
  const imported = vi.spyOn(crypto.subtle, "importKey");
  const encrypted = vi.spyOn(crypto.subtle, "encrypt");
  await sealPrfAndCode({
    prfOutput: prf,
    code: "12345678",
    compartmentKey: key,
    profileId: "p",
    vaultRef: "v",
    policyRevision: 1,
    keyEpoch: 1,
  });
  const hkdf = imported.mock.calls.find((call) => call[2] === "HKDF");
  expect(hkdf?.[1]).toEqual(new Uint8Array(32));
  expect(encrypted.mock.calls[0]?.[2]).toEqual(new Uint8Array(32));
  expect(prf).toEqual(new Uint8Array(32).fill(4));
  expect(key).toEqual(new Uint8Array(32).fill(8));
});
