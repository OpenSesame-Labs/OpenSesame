import { createHash, createHmac, scryptSync } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { type Variables, withContext } from "../middleware/context.js";
import { createInteractionRoutes } from "../routes/interactions.js";
import {
  completeFederatedAuth,
  resetFederatedDiscoveryCache,
} from "./federated.js";
import {
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

function alterPayload(
  cookie: string,
  changed: Partial<PendingFederatedAuth> & { futurePolicy?: string },
): string {
  const split = cookie.lastIndexOf(".");
  const value = JSON.parse(
    Buffer.from(cookie.slice(0, split), "base64url").toString("utf8"),
  );
  const payload = Buffer.from(
    JSON.stringify({ ...value, ...changed }),
  ).toString("base64url");
  return `${payload}${cookie.slice(split)}`;
}

function removePayloadField(
  cookie: string,
  field: keyof PendingFederatedAuth,
): string {
  const split = cookie.lastIndexOf(".");
  const value: Partial<PendingFederatedAuth> = JSON.parse(
    Buffer.from(cookie.slice(0, split), "base64url").toString("utf8"),
  );
  delete value[field];
  return `${Buffer.from(JSON.stringify(value)).toString("base64url")}${cookie.slice(split)}`;
}

function legacyInput(value: PendingFederatedAuth): string {
  const salt = createHash("sha256")
    .update(secret)
    .update("\0opensesame:fed-pending-verifier\0")
    .update(value.state)
    .update(value.nonce)
    .digest()
    .subarray(0, 16);
  const binding = scryptSync(value.verifier, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64url");
  return [
    value.issuer,
    value.state,
    value.nonce,
    binding,
    value.kind ?? "oidc",
    value.providerId ?? "",
  ].join("\x1f");
}

function legacyCookie(value: PendingFederatedAuth): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const tag = createHmac("sha256", secret)
    .update(legacyInput(value))
    .digest("base64url");
  return `${payload}.${tag}`;
}

function existingV3Cookie(value: PendingFederatedAuth): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v3:key")
    .digest();
  const tag = createHmac("sha256", key)
    .update(
      `OpenSesame:federated-pending:v3\0${payload}\0${legacyInput(value)}`,
    )
    .digest("base64url");
  return `${payload}.${tag}`;
}

function existingSealedCookie(value: PendingFederatedAuth): string {
  return encodePending(value, secret, { sealVerifierOnWire: true });
}

function wireJson(cookie: string): {
  verifier?: string;
  verifierEnc?: string;
} {
  const payload = cookie.slice(0, cookie.lastIndexOf("."));
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

const sealOnWire = { sealVerifierOnWire: true as const };
const rolloutOff = { sealVerifierOnWire: false as const };

describe("signed federated state integrity", () => {
  it("round-trips a signed state with its organization and upstream context", () => {
    expect(decodePending(encodePending(pending, secret), secret)).toEqual(
      pending,
    );
  });

  it("round-trips a sealed-on-wire cookie with a fresh random GCM IV", () => {
    const cookie = existingSealedCookie(pending);
    expect(decodePending(cookie, secret)).toEqual(pending);
    const again = encodePending(pending, secret, sealOnWire);
    expect(decodePending(again, secret)).toEqual(pending);
    expect(again).not.toBe(cookie);
  });

  it("seals the verifier on the wire when a pepper is present", () => {
    const cookie = encodePending(pending, secret);
    const wire = wireJson(cookie);
    expect(wire).not.toHaveProperty("verifier");
    expect(wire.verifierEnc).toEqual(expect.any(String));
    expect(encodePending(pending, secret, sealOnWire)).toBe(cookie);
    expect(decodePending(cookie, secret)).toEqual(pending);
  });

  it("keeps a plaintext verifier only when rollout sealing is explicitly off", () => {
    const cookie = encodePending(pending, secret, rolloutOff);
    const wire = wireJson(cookie);
    expect(wire.verifier).toBe(pending.verifier);
    expect(wire).not.toHaveProperty("verifierEnc");
    expect(decodePending(cookie, secret)).toEqual(pending);
    expect(
      decodePending(alterPayload(cookie, { verifier: "changed" }), secret),
    ).toBeUndefined();
  });

  it("rejects a tampered verifier seal", () => {
    const cookie = encodePending(pending, secret, sealOnWire);
    const split = cookie.lastIndexOf(".");
    const wire = JSON.parse(
      Buffer.from(cookie.slice(0, split), "base64url").toString("utf8"),
    );
    wire.verifierEnc = `${wire.verifierEnc}x`;
    const forged = `${Buffer.from(JSON.stringify(wire)).toString("base64url")}${cookie.slice(split)}`;
    expect(decodePending(forged, secret)).toBeUndefined();
  });

  it("rejects a mixed plaintext verifier and sealed verifierEnc", () => {
    const cookie = encodePending(pending, secret, sealOnWire);
    expect(
      decodePending(
        alterPayload(cookie, { verifier: "forged-verifier" }),
        secret,
      ),
    ).toBeUndefined();
  });

  it("rejects decoding with the wrong pepper", () => {
    expect(decodePending(encodePending(pending, secret), "wrong-pepper")).toBe(
      undefined,
    );
  });

  it("rejects swapped verifier seals between two pending legs", () => {
    const other: PendingFederatedAuth = {
      ...pending,
      state: "state-two",
      nonce: "nonce-two",
      verifier: "verifier-two",
    };
    const a = encodePending(pending, secret, sealOnWire);
    const b = encodePending(other, secret, sealOnWire);
    const splitA = a.lastIndexOf(".");
    const splitB = b.lastIndexOf(".");
    const wireA = JSON.parse(
      Buffer.from(a.slice(0, splitA), "base64url").toString("utf8"),
    );
    const wireB = JSON.parse(
      Buffer.from(b.slice(0, splitB), "base64url").toString("utf8"),
    );
    wireB.verifierEnc = wireA.verifierEnc;
    const forged = `${Buffer.from(JSON.stringify(wireB)).toString("base64url")}${b.slice(splitB)}`;
    expect(decodePending(forged, secret)).toBeUndefined();
  });

  it("decodes a frozen historical sealed blob", () => {
    const frozen =
      "eyJpc3N1ZXIiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3RhdGUiOiJzdGF0ZS1leGFtcGxlIiwibm9uY2UiOiJub25jZS1leGFtcGxlIiwia2luZCI6Im9pZGMiLCJwcm92aWRlcklkIjoicHJvdmlkZXItZXhhbXBsZSIsImJ5b0lkIjoiYnlvLWV4YW1wbGUiLCJvcmdJZCI6Im9yZy1leGFtcGxlIiwidmVyaWZpZXJFbmMiOiJNNE50eVFsSWFFX05peHItRlBPa0NxU0k0RU1vY2JOR05kX2JTRHJBZ0RqYXBxNkxfbTFPb2Rialc2SSJ9.8XAuAdF3JCU5Uim5SJqIaI1rVEaJBTGRmFG7KgqxkNY";
    expect(decodePending(frozen, secret)).toEqual(pending);
  });

  it("still decodes legacy v3 cookies that carry a plaintext verifier", () => {
    const cookie = existingV3Cookie(pending);
    expect(decodePending(cookie, secret)).toEqual(pending);
  });

  it.each([
    ["issuer", { issuer: "https://other.example" }],
    ["state", { state: "changed" }],
    ["nonce", { nonce: "changed" }],
    ["verifier", { verifier: "changed" }],
    ["kind", { kind: "oauth2" as const }],
    ["providerId", { providerId: "other" }],
    ["byoId", { byoId: "other" }],
    ["orgId", { orgId: "other" }],
  ])("rejects a changed %s", (_field, changed) => {
    expect(
      decodePending(
        alterPayload(encodePending(pending, secret), changed),
        secret,
      ),
    ).toBeUndefined();
  });

  it("authenticates new fields even before the decoder uses them", () => {
    expect(
      decodePending(
        alterPayload(encodePending(pending, secret), {
          futurePolicy: "changed",
        }),
        secret,
      ),
    ).toBeUndefined();
  });

  it("accepts a legacy signature only when no unsigned provenance is present", () => {
    const legacy = {
      issuer: pending.issuer,
      state: pending.state,
      nonce: pending.nonce,
      verifier: pending.verifier,
      kind: "oidc" as const,
      providerId: "provider-example",
    };
    const cookie = legacyCookie(legacy);
    expect(decodePending(cookie, secret)).toEqual(legacy);
    expect(
      decodePending(alterPayload(cookie, { orgId: "org-example" }), secret),
    ).toBeUndefined();
    expect(
      decodePending(alterPayload(cookie, { byoId: "byo-example" }), secret),
    ).toBeUndefined();
    expect(
      decodePending(alterPayload(cookie, { futurePolicy: "changed" }), secret),
    ).toBeUndefined();
    expect(decodePending(legacyCookie(pending), secret)).toBeUndefined();
  });

  it("accepts legacy static provenance only with a signed nonempty provider", () => {
    const legacy = {
      issuer: pending.issuer,
      state: pending.state,
      nonce: pending.nonce,
      verifier: pending.verifier,
      providerId: "provider-example",
    };
    const cookie = legacyCookie(legacy);
    expect(decodePending(cookie, secret)).toEqual(legacy);
    expect(
      decodePending(alterPayload(cookie, { kind: "oidc" }), secret),
    ).toEqual({
      ...legacy,
      kind: "oidc",
    });
    expect(
      decodePending(removePayloadField(cookie, "providerId"), secret),
    ).toBeUndefined();
    expect(
      decodePending(alterPayload(cookie, { providerId: "" }), secret),
    ).toBeUndefined();
    expect(
      decodePending(alterPayload(cookie, { providerId: "other" }), secret),
    ).toBeUndefined();
    const noProvider = { ...legacy, providerId: "" };
    expect(decodePending(legacyCookie(noProvider), secret)).toBeUndefined();
    expect(
      decodePending(
        removePayloadField(legacyCookie(noProvider), "providerId"),
        secret,
      ),
    ).toBeUndefined();
  });

  it.each(["orgId", "byoId"] as const)(
    "rejects a legacy %s cookie after its unsigned owner is stripped",
    (field) => {
      const legacy: PendingFederatedAuth = {
        issuer: pending.issuer,
        state: pending.state,
        nonce: pending.nonce,
        verifier: pending.verifier,
        kind: "oidc",
        [field]: "old-owner",
      };
      const cookie = legacyCookie(legacy);
      const stripped = removePayloadField(cookie, field);
      expect(decodePending(cookie, secret)).toBeUndefined();
      expect(decodePending(stripped, secret)).toBeUndefined();
      expect(
        decodePending(
          alterPayload(stripped, { providerId: "provider-example" }),
          secret,
        ),
      ).toBeUndefined();
      expect(decodePending(existingV3Cookie(legacy), secret)).toEqual(legacy);
    },
  );
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
    const cookie = removePayloadField(legacyCookie(legacy), field);
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
