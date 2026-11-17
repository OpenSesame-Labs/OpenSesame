import { withTestResources } from "@opensesame/testing";
import { importJWK, jwtVerify } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { obtainReferenceOidcGrant, startReferenceIdp } from "./testkit.js";

afterEach(() => vi.restoreAllMocks());

it("refuses nonlocal issuers and noncanonical RP origins before network access", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  for (const issuer of [
    "https://issuer.example",
    "http://127.0.0.1.evil.example:4711",
    "http://user@127.0.0.1:4711",
    "http://127.0.0.1:4711/path",
  ]) {
    await expect(obtainReferenceOidcGrant({ issuer })).rejects.toThrow(
      "reference IdP issuer must be a loopback origin",
    );
  }
  await expect(
    obtainReferenceOidcGrant(
      { issuer: "http://127.0.0.1:4711" },
      "https://rp.example/path",
    ),
  ).rejects.toThrow("reference relying party must be a canonical HTTP origin");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("never follows an authorization redirect to a different relying party", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/callback?code=wrong" },
    }),
  );
  await expect(
    obtainReferenceOidcGrant({ issuer: "http://127.0.0.1:4711" }),
  ).rejects.toThrow("reference authorization callback mismatch");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
});

it("refuses a token endpoint redirect before it can send the verifier onward", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("code", "test-code");
        return new Response(null, {
          status: 302,
          headers: { location: callback.href },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/token" },
      });
    });
  await expect(
    obtainReferenceOidcGrant({ issuer: "http://127.0.0.1:4711" }),
  ).rejects.toThrow("reference token exchange failed: 302");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
});

it("does not turn an IdP client-mode refusal into a successful grant", async () => {
  await withTestResources(async (scope) => {
    const idp = scope.use(
      await startReferenceIdp({ clientMode: "confidential" }),
    );
    await expect(obtainReferenceOidcGrant(idp)).rejects.toThrow(
      "reference authorization failed: 400",
    );
  });
});

it("refuses a token response that does not allow the RP origin", async () => {
  await withTestResources(async (scope) => {
    const idp = scope.use(await startReferenceIdp());
    const wireFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await wireFetch(input, init);
      if (new URL(String(input)).pathname !== "/token") return response;
      const headers = new Headers(response.headers);
      headers.delete("access-control-allow-origin");
      return new Response(response.body, { status: response.status, headers });
    });
    await expect(obtainReferenceOidcGrant(idp)).rejects.toThrow(
      "reference token exchange did not allow the RP origin",
    );
  });
});

it("issues signed, nonce-bound grants with separate pairwise RP subjects", async () => {
  await withTestResources(async (scope) => {
    const idp = scope.use(await startReferenceIdp());
    const first = await obtainReferenceOidcGrant(idp, "https://rp-a.example");
    const second = await obtainReferenceOidcGrant(idp, "https://rp-b.example");
    const key = await importJWK(idp.publicJwk, "RS256");
    const firstToken = await jwtVerify(first.idToken, key, {
      issuer: idp.issuer,
      audience: first.clientId,
    });
    const secondToken = await jwtVerify(second.idToken, key, {
      issuer: idp.issuer,
      audience: second.clientId,
    });
    expect(firstToken.payload.nonce).toBe(first.nonce);
    expect(secondToken.payload.nonce).toBe(second.nonce);
    expect(firstToken.payload.sub).toBeTruthy();
    expect(secondToken.payload.sub).toBeTruthy();
    expect(firstToken.payload.sub).not.toBe(secondToken.payload.sub);
  });
});
