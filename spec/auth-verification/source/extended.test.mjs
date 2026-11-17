import assert from "node:assert/strict";
import test from "node:test";
import { readSources, renderProof } from "./verify.mjs";

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
      "legacyEligible = data.orgId === undefined && data.byoId === undefined;",
      "legacyEligible = true;",
    ),
    replaceOnce(
      sources.federatedPending,
      "return `${payload}.${modernPendingSignature(payload, legacyInput, secret)}`;",
      "return `${payload}.${pendingSignature(legacyInput, secret)}`;",
    ),
    replaceOnce(
      sources.federatedPending,
      "const expected = modernPendingSignature(payload, legacyInput, secret);",
      "const expected = pendingSignature(legacyInput, secret);",
    ),
    replaceOnce(
      sources.federatedPending,
      "authenticatedPayload(payload, legacyInput)",
      "legacyInput",
    ),
    replaceOnce(
      sources.federatedPending,
      'update("OpenSesame:federated-pending:v3:key")',
      'update("OpenSesame:federated-pending:legacy:key")',
    ),
    replaceOnce(
      sources.federatedPending,
      "if (signatureMatches(supplied, expected)) return payload;",
      "return payload;",
    ),
  ];
  for (const federatedPending of changes)
    assert.throws(
      () => renderProof({ ...sources, federatedPending }),
      /Unsupported authentication source/,
    );
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
      "trust.provider.id === pending.providerId",
      "trust.provider.id !== pending.providerId",
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
