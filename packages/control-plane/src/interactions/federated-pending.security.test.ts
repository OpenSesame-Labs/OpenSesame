import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HttpBindings } from "@hono/node-server";
import { overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  frozenV3Sealed,
  legacyCookie,
  plaintextV3Cookie,
} from "../__tests__/federated-pending-formats.test-support.js";
import type { AppContext } from "../context.js";
import { type Variables, withContext } from "../middleware/context.js";
import { createInteractionRoutes } from "../routes/interactions.js";
import {
  completeFederatedAuth,
  resetFederatedDiscoveryCache,
} from "./federated.js";
import {
  type PendingCookieKeys,
  type PendingFederatedAuth,
  decodePending,
  encodePending,
} from "./federated-pending.js";
import { callbackTrustMatchesPending } from "./federated-trust-binding.js";
import { resolveTrustedIssuer } from "./trust.js";

const secret = "local-test-pepper-with-no-production-credentials";
const pending: PendingFederatedAuth = {
  issuer: "https://issuer.example",
  state: "state-example",
  nonce: "nonce-example",
  verifier: "verifier-example",
  kind: "oidc",
  providerId: "provider-example",
  byoId: "byo-example",
  orgId: "org-example",
};

/** Any field a pending cookie payload has ever carried, plus an unknown one. */
const wireFieldsSchema = z
  .object({
    issuer: z.string(),
    state: z.string(),
    nonce: z.string(),
    verifier: z.string(),
    verifierEnc: z.string(),
    kind: z.string(),
    providerId: z.string(),
    byoId: z.string(),
    orgId: z.string(),
    futurePolicy: z.string(),
  })
  .partial()
  .strict();
type WireFields = z.infer<typeof wireFieldsSchema>;

function wireJson(cookie: string): WireFields {
  const payload = cookie.slice(0, cookie.lastIndexOf("."));
  return wireFieldsSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
}

function withPayload(cookie: string, value: WireFields): string {
  const tag = cookie.slice(cookie.lastIndexOf("."));
  return `${Buffer.from(JSON.stringify(value)).toString("base64url")}${tag}`;
}

function alterPayload(
  cookie: string,
  changed: Partial<PendingFederatedAuth> & { futurePolicy?: string },
): string {
  return withPayload(cookie, { ...wireJson(cookie), ...changed });
}

function removePayloadField(
  cookie: string,
  field: keyof PendingFederatedAuth,
): string {
  const value = wireJson(cookie);
  delete value[field];
  return withPayload(cookie, value);
}

/** A correct v4 tag over arbitrary payload JSON, as only the pepper holder can make. */
function signV4(value: WireFields): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v4:key")
    .digest();
  const tag = createHmac("sha256", key)
    .update(`OpenSesame:federated-pending:v4\0${payload}`)
    .digest("base64url");
  return `${payload}.${tag}`;
}

/** Counts every key derivation the codec performs. */
function countingKeys(): PendingCookieKeys & { calls: number } {
  const keys = {
    calls: 0,
    verifierSealKey(s: string, state: string, nonce: string): Buffer {
      keys.calls += 1;
      return createHash("sha256").update(`${s}\0${state}\0${nonce}`).digest();
    },
  };
  return keys;
}

describe("signed federated state integrity", () => {
  it("round-trips a signed state with its organization and upstream context", () => {
    expect(decodePending(encodePending(pending, secret), secret)).toEqual(
      pending,
    );
  });

  it("seals the verifier on the wire with a fresh GCM IV per cookie", () => {
    const cookie = encodePending(pending, secret);
    const wire = wireJson(cookie);
    expect(wire).not.toHaveProperty("verifier");
    expect(wire.verifierEnc).toEqual(expect.any(String));
    expect(JSON.stringify(wire)).not.toContain(pending.verifier);
    const again = encodePending(pending, secret);
    expect(again).not.toBe(cookie);
    expect(decodePending(again, secret)).toEqual(pending);
  });

  it.each([
    ["issuer", { issuer: "https://other.example" }],
    ["state", { state: "changed" }],
    ["nonce", { nonce: "changed" }],
    ["kind", { kind: "oauth2" as const }],
    ["providerId", { providerId: "other" }],
    ["byoId", { byoId: "other" }],
    ["orgId", { orgId: "other" }],
    ["future field", { futurePolicy: "changed" }],
  ])("rejects a changed %s", (_field, changed) => {
    const cookie = encodePending(pending, secret);
    expect(decodePending(alterPayload(cookie, changed), secret)).toBe(
      undefined,
    );
  });

  it("rejects a tampered or swapped verifier seal", () => {
    const cookie = encodePending(pending, secret);
    const wire = wireJson(cookie);
    expect(
      decodePending(
        withPayload(cookie, { ...wire, verifierEnc: `${wire.verifierEnc}x` }),
        secret,
      ),
    ).toBeUndefined();
    const other = encodePending(
      { ...pending, state: "state-two", nonce: "nonce-two", verifier: "v2" },
      secret,
    );
    expect(
      decodePending(
        withPayload(other, {
          ...wireJson(other),
          verifierEnc: wire.verifierEnc,
        }),
        secret,
      ),
    ).toBeUndefined();
  });

  it("rejects decoding with the wrong pepper", () => {
    expect(
      decodePending(encodePending(pending, secret), "wrong-pepper"),
    ).toBeUndefined();
  });

  it("fails closed on a plaintext or mixed verifier even under a valid v4 tag", () => {
    const { verifier, ...rest } = pending;
    const sealed = wireJson(encodePending(pending, secret));
    // Only the pepper holder can make these tags; the decoder still refuses
    // the shapes no v4 encoder writes rather than giving them meaning.
    expect(decodePending(signV4({ ...rest, verifier }), secret)).toBe(
      undefined,
    );
    expect(decodePending(signV4({ ...sealed, verifier }), secret)).toBe(
      undefined,
    );
    expect(decodePending(signV4(sealed), secret)).toEqual(pending);
  });

  it("refuses a v3 cookie that main emitted before v4", () => {
    expect(decodePending(frozenV3Sealed, secret)).toBeUndefined();
  });

  it("refuses v3 plaintext and legacy signatures, so their sign-ins restart", () => {
    const { byoId: _b, orgId: _o, ...staticLeg } = pending;
    expect(
      decodePending(plaintextV3Cookie(pending, secret), secret),
    ).toBeUndefined();
    expect(
      decodePending(legacyCookie(staticLeg, secret), secret),
    ).toBeUndefined();
  });

  it("derives no key and runs no slow hash before the MAC verifies", () => {
    const keys = countingKeys();
    const valid = encodePending(pending, secret, keys);
    expect(keys.calls).toBe(1);
    const forged = [
      frozenV3Sealed,
      alterPayload(valid, { orgId: "attacker" }),
      `${valid.slice(0, valid.lastIndexOf("."))}.${"A".repeat(43)}`,
      withPayload(valid, { ...wireJson(valid), verifier: "x" }),
      `${"A".repeat(5000)}.${"A".repeat(43)}`,
      "not-a-cookie",
    ];
    keys.calls = 0;
    for (const raw of forged)
      expect(decodePending(raw, secret, keys)).toBeUndefined();
    expect(decodePending(valid, "wrong-pepper", keys)).toBeUndefined();
    expect(keys.calls).toBe(0);
    expect(decodePending(valid, secret, keys)).toEqual(pending);
    expect(keys.calls).toBe(1);
  });

  it("keeps slow password hashing out of the pending cookie codec", () => {
    const source = readFileSync(
      new URL("./federated-pending.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b(scrypt|pbkdf2|argon2|bcrypt)\w*\(/i);
  });
});

it.each(["orgId", "byoId"] as const)(
  "refuses a stripped legacy %s callback before trust lookup or exchange",
  async (field) => {
    const legacy: PendingFederatedAuth = {
      issuer: pending.issuer,
      state: pending.state,
      nonce: pending.nonce,
      verifier: pending.verifier,
      kind: "oidc",
      [field]: "old-owner",
    };
    const cookie = removePayloadField(legacyCookie(legacy, secret), field);
    const lookup = vi.fn();
    const identity = vi.fn();
    const network = vi.spyOn(globalThis, "fetch");
    // SAFETY: the refusal path reads only these context and adapter fields.
    const ctx: AppContext = overlapCast({
      config: { claimPepper: secret, trustedUpstreamIssuers: [legacy.issuer] },
      oauth: {
        provider: {
          interactionDetails: vi.fn().mockResolvedValue({
            uid: "test",
            prompt: { name: "login" },
          }),
        },
      },
      repos: {
        byoUpstreams: { findByIssuer: lookup },
        externalIdentities: { findByTuple: identity },
      },
      stores: { organizations: { findByIssuer: lookup } },
    });
    const app = new Hono<{ Bindings: HttpBindings; Variables: Variables }>();
    app.use("*", withContext(ctx));
    app.route("/interaction", createInteractionRoutes());
    try {
      const response = await app.request(
        "/interaction/test/federated/callback?code=unused",
        { headers: { cookie: `os.fed.test=${cookie}` } },
        overlapCast({ incoming: {}, outgoing: {} }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        "Sign-in state did not match. Start the sign-in again.",
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(identity).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
);

it("binds OAuth2 callbacks to the same static OAuth2 provider", () => {
  const trust = {
    source: "static" as const,
    provider: {
      id: "provider-example",
      kind: "oauth2" as const,
      label: "Provider",
      issuer: pending.issuer,
      clientAuth: "none" as const,
      scopes: "read",
    },
  };
  const oauth = {
    issuer: pending.issuer,
    state: pending.state,
    nonce: pending.nonce,
    verifier: pending.verifier,
    kind: "oauth2" as const,
    providerId: "provider-example",
  };
  expect(callbackTrustMatchesPending(trust, oauth)).toBe(true);
  expect(
    callbackTrustMatchesPending(trust, { ...oauth, providerId: "other" }),
  ).toBe(false);
  expect(callbackTrustMatchesPending(trust, { ...oauth, orgId: "org" })).toBe(
    false,
  );
  expect(callbackTrustMatchesPending(trust, { ...oauth, byoId: "byo" })).toBe(
    false,
  );
  expect(callbackTrustMatchesPending(trust, { ...oauth, kind: "oidc" })).toBe(
    false,
  );
});

it("refuses a changed trust owner at the exchange's own lookup", async () => {
  const issuer = "https://shoo.dev";
  // SAFETY: resolveTrustedIssuer and the refusal path read only these config
  // and store fields; the real route supplies the complete AppContext.
  const ctx: AppContext = overlapCast({
    config: {
      publicUrl: "https://identity.example",
      allowDevDefaults: false,
      trustedUpstreamIssuers: [],
      providers: [],
    },
    repos: {
      byoUpstreams: {
        findByIssuer: async () => ({ id: "byo-old", state: "active" }),
      },
    },
    stores: { organizations: { findByIssuer: async () => undefined } },
  });
  const started = await resolveTrustedIssuer(ctx, issuer);
  expect(started).toMatchObject({ source: "byo", record: { id: "byo-old" } });
  const originalPending = {
    issuer,
    state: "state-example",
    nonce: "nonce-example",
    verifier: "verifier-example",
    byoId: "byo-old",
  };

  // The route's first lookup can have seen the BYO record above. Before the
  // OIDC leg resolves its own trust, an operator adds this issuer statically.
  ctx.config.trustedUpstreamIssuers.push(issuer);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected network"));
  try {
    const [result] = await Promise.allSettled([
      completeFederatedAuth(
        ctx,
        originalPending,
        new URL("https://identity.example/cb?code=c&state=state-example"),
      ),
    ]);
    expect(network).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "rejected",
      reason: { code: "untrusted_issuer" },
    });
  } finally {
    network.mockRestore();
    resetFederatedDiscoveryCache();
  }
});
