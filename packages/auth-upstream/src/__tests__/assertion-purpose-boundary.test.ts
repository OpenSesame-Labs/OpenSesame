import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import type { PasskeyAssertion, PasskeyCredential } from "../passkey.js";
import { simpleWebAuthnSeams } from "../simplewebauthn.js";
import {
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
} from "../webauthn.js";

afterEach(() => vi.restoreAllMocks());

it("does not redeem registration challenges through assertion verification", async () => {
  const store = createMemoryChallengeStore();
  store.set("registration-challenge", {
    principalId: "person",
    purpose: "registration",
    expiresAt: Date.now() + 60_000,
  });
  const cryptography = vi
    .spyOn(simpleWebAuthnSeams, "verifyAuthenticationResponse")
    .mockResolvedValue(
      overlapCast({ verified: true, authenticationInfo: { newCounter: 1 } }),
    );
  const assertion: PasskeyAssertion = overlapCast({
    credentialId: "credential",
    clientDataJSON: new TextEncoder().encode(
      JSON.stringify({ challenge: "registration-challenge" }),
    ),
    authenticatorData: new Uint8Array([0]),
    signature: new Uint8Array([1]),
    expectedPurpose: "registration",
  });
  const credential: PasskeyCredential = {
    credentialId: "credential",
    publicKey: new Uint8Array([1]),
    counter: 0,
    principalId: "person",
  };
  const verify = createSimpleWebAuthnVerifyFn(
    { rpID: "example.test", origin: "https://example.test" },
    store,
  );
  await expect(verify(assertion, credential)).resolves.toBe(false);
  expect(cryptography).not.toHaveBeenCalled();
  expect(store.peek("registration-challenge")).toBeUndefined();
});
