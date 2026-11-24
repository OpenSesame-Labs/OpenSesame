import assert from "node:assert/strict";
import test from "node:test";
import { readSources, renderProof, verifyProof } from "./verify.mjs";

const sources = await readSources();

function replaceOnce(source, before, after) {
  assert.equal(
    source.split(before).length,
    2,
    `mutation must match once: ${before}`,
  );
  return source.replace(before, after);
}

test("the source check rejects WebAuthn purpose, principal, and consumption bypasses", () => {
  const changes = [
    replaceOnce(
      sources.webauthn,
      'expectedPurpose !== "transaction"',
      'expectedPurpose !== "registration"',
    ),
    replaceOnce(
      sources.webauthn,
      'expectedPurpose !== "transaction"',
      'expectedPurpose !== "trans action"',
    ),
    replaceOnce(
      sources.webauthn,
      "issued.principalId !== credential.principalId",
      "issued.principalId === credential.principalId",
    ),
    replaceOnce(
      sources.webauthn,
      "const issued = await store.consume(challenge);\n    // The purpose",
      "const issued = await store.peek(challenge);\n    // The purpose",
    ),
    replaceOnce(
      sources.webauthn,
      "if (!challenge || !isString(challenge)) return false;",
      "if (!challenge || !isString(challenge)) returnfalse;",
    ),
  ];
  for (const webauthn of changes)
    assert.throws(
      () => renderProof({ ...sources, webauthn }),
      /Unsupported authentication source/,
    );
});

test("the source check rejects claim completion without review or a principal", () => {
  const claim = sources.graphs.claim;
  const changes = [
    replaceOnce(
      claim,
      "if (!completedByPrincipalId) {",
      "if (completedByPrincipalId) {",
    ),
    replaceOnce(
      claim,
      'if (session.state !== "reviewed")',
      'if (session.state === "reviewed")',
    ),
    replaceOnce(
      claim,
      "    completedByPrincipalId,\n  });",
      '    completedByPrincipalId: "",\n  });',
    ),
  ];
  for (const change of changes)
    assert.throws(
      () =>
        renderProof({
          ...sources,
          graphs: { ...sources.graphs, claim: change },
        }),
      /Unsupported authentication source/,
    );
});

test("the source check rejects weakened SAML replay, expiry, capacity, and key binding", () => {
  const changes = [
    replaceOnce(sources.saml, "accepted.has(key) ||", "false ||"),
    replaceOnce(
      sources.saml,
      "claims.validUntil <= now",
      "claims.validUntil < now",
    ),
    replaceOnce(sources.saml, "accepted.size >= 1024", "accepted.size > 1024"),
    replaceOnce(sources.saml, "accepted.set(key, claims.validUntil);", ""),
    replaceOnce(
      sources.saml,
      "JSON.stringify([claims.issuer, claims.assertionId])",
      "JSON.stringify([claims.assertionId])",
    ),
    replaceOnce(sources.saml, "expiry <= now", "expiry < now"),
    `${sources.saml}\naccepted.clear();\n`,
  ];
  for (const saml of changes)
    assert.throws(
      () => renderProof({ ...sources, saml }),
      /Unsupported authentication source/,
    );
});

test("the source check rejects stale passkey verification, counter and ownership bypasses", () => {
  const changes = [
    replaceOnce(
      sources.passkey,
      "current.generation !== generation",
      "current.generation === generation",
    ),
    replaceOnce(
      sources.passkey,
      "await credentials.advance(credentialId, generation, next)",
      "true",
    ),
    replaceOnce(
      sources.passkey,
      "counter <= current.counter",
      "counter < current.counter",
    ),
    replaceOnce(
      sources.passkey,
      "credentials.get(id)?.principalId !== principalId",
      "false",
    ),
    replaceOnce(
      sources.passkey,
      "generation: randomUUID()",
      'generation: "fixed"',
    ),
    replaceOnce(
      sources.passkey,
      "publicKey: ownBytes(record.publicKey)",
      "publicKey: record.publicKey",
    ),
  ];
  for (const passkey of changes)
    assert.throws(
      () => renderProof({ ...sources, passkey }),
      /Unsupported authentication source/,
    );
});

test("the source check rejects issuer precedence and eligibility changes", () => {
  const changes = [
    replaceOnce(
      sources.issuerTrust,
      'if (provider) return { source: "static", provider };',
      "if (provider) return undefined;",
    ),
    replaceOnce(
      sources.issuerTrust,
      "if (organization) return organization;",
      "if (organization) return undefined;",
    ),
    replaceOnce(
      sources.issuerTrust,
      'record.state === "active"',
      'record.state !== "active"',
    ),
    replaceOnce(
      sources.issuerTrust,
      'organization.state !== "suspended"',
      'organization.state === "suspended"',
    ),
    replaceOnce(
      sources.issuerTrust,
      "if (!normalized) return undefined;",
      'if (!normalized) return { source: "byo" };',
    ),
  ];
  for (const issuerTrust of changes)
    assert.throws(
      () => renderProof({ ...sources, issuerTrust }),
      /Unsupported authentication source/,
    );
});

test("the source check rejects federation cookie integrity and downgrade changes", () => {
  const changes = [
    replaceOnce(
      sources.federatedPending,
      ".update(MAC_DOMAIN).update(payload)",
      '.update(MAC_DOMAIN).update("")',
    ),
    replaceOnce(
      sources.federatedPending,
      'const MAC_KEY_LABEL = "OpenSesame:federated-pending:v4:key";',
      'const MAC_KEY_LABEL = "OpenSesame:federated-pending:v3:key";',
    ),
    replaceOnce(
      sources.federatedPending,
      ".extend({ verifierEnc: z.string() })\n  .strict();",
      ".extend({ verifierEnc: z.string(), verifier: z.string().optional() });",
    ),
    replaceOnce(
      sources.federatedPending,
      'import { z } from "zod";',
      'import { scryptSync } from "node:crypto";\nimport { z } from "zod";',
    ),
  ];
  for (const federatedPending of changes)
    assert.throws(
      () => renderProof({ ...sources, federatedPending }),
      /Unsupported authentication source/,
    );
});

// FED-I4 from the code: these edits to `decodeSigned` translate, and Lean
// rejects the resulting statement order or the missing guard.
test("Lean rejects a decodeSigned that drops, reorders or adds work around the MAC", async () => {
  const parse = "  const wire = parseWire(sealedWireSchema, payload);\n";
  const mac = "  const expected = pendingMac(payload, secret);\n";
  const changes = [
    ["the alphabet guard", "if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;", ""],
    ["the tag comparison", "if (!timingSafeEqual(supplied, expected)) return undefined;", ""],
    ["the length cap", "  if (raw.length > MAX_PENDING_COOKIE_LENGTH) return undefined;", ""],
    ["parse before the MAC", mac, parse + mac],
    ["a password hash", mac, `${mac}  const slow = scryptSync(payload, secret, 64);\n`],
  ];
  for (const [name, before, after] of changes) {
    let federatedPending = replaceOnce(sources.federatedPending, before, after);
    if (name === "parse before the MAC")
      federatedPending = federatedPending.replace(
        `${parse}  if (wire === undefined) return undefined;`,
        "  if (wire === undefined) return undefined;",
      );
    await assert.rejects(
      verifyProof(renderProof({ ...sources, federatedPending })),
      /Lean rejected source proof/,
      name,
    );
  }
});

test("the source check rejects federated authority rebinding", () => {
  const bindingChanges = [
    replaceOnce(
      sources.federatedTrustBinding,
      '      trust.source === "static" &&\n      trust.provider.id === pending.providerId &&',
      "      true &&\n      trust.provider.id === pending.providerId &&",
    ),
    replaceOnce(
      sources.federatedTrustBinding,
      '      trust.provider.id === pending.providerId &&\n      trust.provider.kind === "oidc"',
      '      trust.provider.id !== pending.providerId &&\n      trust.provider.kind === "oidc"',
    ),
    replaceOnce(
      sources.federatedTrustBinding,
      "if (provenanceCount > 1) return false;",
      "if (provenanceCount > 2) return false;",
    ),
    replaceOnce(
      sources.federatedTrustBinding,
      'return trust.source === "static" && trust.provider.kind === "oidc";',
      "return true;",
    ),
    replaceOnce(
      sources.federatedTrustBinding,
      'if ((pending.kind ?? "oidc") !== "oidc") return false;',
      "if (false) return false;",
    ),
    replaceOnce(
      sources.federatedTrustBinding,
      'trust.provider.id === pending.providerId &&\n      trust.provider.kind === "oidc"',
      'trust.provider.id === pending.providerId &&\n      trust.provider.kind === "oauth2"',
    ),
  ];
  for (const federatedTrustBinding of bindingChanges)
    assert.throws(
      () => renderProof({ ...sources, federatedTrustBinding }),
      /Unsupported authentication source/,
    );

  const callbackChanges = [
    replaceOnce(
      sources.federated,
      "  if (!trustMatchesPending(trust, pending)) rejectTrustRebinding();\n",
      "",
    ),
    replaceOnce(
      sources.federated,
      "  const trust = await resolveTrustedIssuer(ctx, issuer);",
      '  const trust = { source: "byo", record: attacker };',
    ),
    replaceOnce(
      sources.federated,
      "  if (!trustMatchesPending(trust, pending)) rejectTrustRebinding();\n  const mode = await clientModeFor(ctx.config, trust);",
      "  const mode = await clientModeFor(ctx.config, trust);\n  if (!trustMatchesPending(trust, pending)) rejectTrustRebinding();",
    ),
    replaceOnce(
      sources.federated,
      "...pendingProvenance(trust)",
      "...pendingProvenance(await resolveOrRefuse(ctx, issuer))",
    ),
    replaceOnce(
      sources.federated,
      "  return {\n    authorizationUrl: url.href,\n    pending: { issuer, state, nonce, verifier, ...pendingProvenance(trust) },\n  };",
      "  const ignored = { ...pendingProvenance(trust) };\n  return {\n    authorizationUrl: url.href,\n    pending: { issuer, state, nonce, verifier },\n  };",
    ),
  ];
  for (const federated of callbackChanges)
    assert.throws(
      () => renderProof({ ...sources, federated }),
      /Unsupported authentication source/,
    );
});
