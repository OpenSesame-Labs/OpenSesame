import {
  obtainReferenceOidcGrant,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { verifyIdToken } from "./id-token.js";

describe("SDK ID-token verification against the reference IdP", () => {
  it("verifies a signed PKCE grant through real discovery and JWKS; rejects mismatches", async () => {
    await withTestResources(async (scope) => {
      const idp = scope.use(
        await startReferenceIdp({
          clientMode: "origin_profile",
          subject: "test-reference-user",
        }),
      );
      const grant = await obtainReferenceOidcGrant(idp);
      const fetched: string[] = [];
      const wireFetch: typeof fetch = async (input, init) => {
        fetched.push(String(input));
        return fetch(input, init);
      };
      const options = {
        issuer: grant.issuer,
        audience: grant.clientId,
        nonce: grant.nonce,
        fetchImpl: wireFetch,
      };
      const verified = await verifyIdToken(grant.idToken, options);
      expect(verified.iss).toBe(idp.issuer);
      expect(verified.aud).toBe(grant.clientId);
      expect(verified.nonce).toBe(grant.nonce);
      expect(verified.sub).not.toBe("test-reference-user");
      expect(verified.sub).toBeTruthy();
      expect(idp.lastNonce()).toBe(grant.nonce);
      expect(idp.tokenOriginSeen()).toBe("http://127.0.0.1:4711");
      expect(idp.tokenClientSeen()).toMatchObject({ id: grant.clientId });
      expect(idp.tokenClientSeen().secret).toBeUndefined();
      expect(fetched).toEqual([
        `${idp.issuer}/.well-known/openid-configuration`,
        `${idp.issuer}/jwks`,
      ]);

      await expect(
        verifyIdToken(grant.idToken, { ...options, nonce: "another-nonce" }),
      ).rejects.toMatchObject({ name: "AuthError", code: "nonce_mismatch" });
      await expect(
        verifyIdToken(grant.idToken, { ...options, audience: "another-rp" }),
      ).rejects.toMatchObject({ name: "AuthError", code: "invalid_audience" });

      const other = scope.use(await startReferenceIdp());
      expect(other.publicJwk.kid).toBe(idp.publicJwk.kid);
      expect(other.publicJwk.n).not.toBe(idp.publicJwk.n);
      const wrongKeyReads: { url: string; status: number }[] = [];
      const wrongKeyFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        wrongKeyReads.push({ url: String(input), status: response.status });
        return response;
      };
      await expect(
        verifyIdToken(grant.idToken, {
          ...options,
          jwksUri: `${other.issuer}/jwks`,
          fetchImpl: wrongKeyFetch,
        }),
      ).rejects.toMatchObject({
        name: "AuthError",
        code: "invalid_token",
        message: "Token signature verification failed",
      });
      expect(wrongKeyReads).toEqual([
        { url: `${other.issuer}/jwks`, status: 200 },
      ]);
    });
  });
});
