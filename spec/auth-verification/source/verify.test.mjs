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

test("the actual cookie decision and authorization graph satisfy the Lean contracts", async () => {
  await verifyProof(renderProof(sources));
});

test("Lean rejects a source change that admits a missing cookie origin", async () => {
  const cookie = replaceOnce(
    sources.cookie,
    "if (!origin) return false;",
    "if (!origin) return true;",
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, cookie })),
    /Lean rejected source proof/,
  );
});

test("Lean rejects a principal check that no longer denies suspended principals", async () => {
  const cookie = replaceOnce(
    sources.cookie,
    '    principal.state !== "suspended" &&\n    principal.state !== "closed"\n  );',
    '    true &&\n    principal.state !== "closed"\n  );',
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, cookie })),
    /Lean rejected source proof/,
  );
});

test("Lean rejects a state read moved before the null checks", async () => {
  const cookie = replaceOnce(
    sources.cookie,
    '    principal !== null &&\n    principal !== undefined &&\n    principal.state !== "suspended" &&',
    '    principal.state !== "suspended" &&\n    principal !== null &&\n    principal !== undefined &&',
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, cookie })),
    /Lean rejected source proof/,
  );
});

test("Lean rejects an OIDC callback that omits state binding", async () => {
  const oidc = replaceOnce(
    sources.oidc,
    "response.state !== pair.state ||",
    "false ||",
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, oidc })),
    /Lean rejected source proof/,
  );
});

test("Lean rejects callbacks that admit expired or error responses", async () => {
  for (const condition of ["Date.now() >= expiresAt ||", "response.error ||"]) {
    const oidc = replaceOnce(sources.oidc, condition, "false ||");
    await assert.rejects(
      verifyProof(renderProof({ ...sources, oidc })),
      /Lean rejected source proof/,
    );
  }
});

test("Lean rejects a callback that reads missing code before checking it", async () => {
  const oidc = replaceOnce(
    sources.oidc,
    "      !response.code ||\n      response.code.length > 4096",
    "      response.code.length > 4096 ||\n      !response.code",
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, oidc })),
    /Lean rejected source proof/,
  );
});

test("the translator refuses OIDC replay-order and token-binding changes", () => {
  const mutations = [
    replaceOnce(
      sources.oidc,
      "    spent = true;\n    owner.assertCurrent();",
      "    owner.assertCurrent();\n    spent = true;",
    ),
    replaceOnce(sources.oidc, "      pair.codeVerifier,", "      pair.state,"),
    replaceOnce(
      sources.oidc,
      "      nonce: pair.nonce,\n      jwksUri:",
      "      nonce: pair.state,\n      jwksUri:",
    ),
    `${sources.oidc}\nprepareConfiguredOidc = async () => ({});\n`,
  ];
  for (const oidc of mutations)
    assert.throws(
      () => renderProof({ ...sources, oidc }),
      /Unsupported authentication source/,
    );
});

test("the translator refuses changed evidence deletion, expiry, and registration", () => {
  const reordered = replaceOnce(
    sources.evidence,
    "  pending.delete(proof);\n",
    "",
  );
  const mutations = [
    replaceOnce(
      reordered,
      "  value.owner.assertCurrent();\n",
      "  value.owner.assertCurrent();\n  pending.delete(proof);\n",
    ),
    reordered,
    replaceOnce(
      sources.evidence,
      "value.claims.validUntil <= Date.now()",
      "value.claims.validUntil < Date.now()",
    ),
    replaceOnce(sources.evidence, "pending.get(proof)", "pending.get(other)"),
    replaceOnce(sources.evidence, "pending.set(proof,", "pending.set(other,"),
    replaceOnce(
      sources.evidence,
      "Object.freeze({ [proofBrand]: true })",
      "input.token as unknown as NativeOidcProof",
    ),
    `${sources.evidence}\npending.set(proof, value);\n`,
  ];
  for (const evidence of mutations)
    assert.throws(
      () => renderProof({ ...sources, evidence }),
      /Unsupported authentication source/,
    );
});

test("Lean rejects both a reopened terminal request and a missing permitted edge", async () => {
  const reopened = replaceOnce(
    sources.machine,
    "approved: [],",
    'approved: ["pending"],',
  );
  const missing = replaceOnce(
    sources.machine,
    'pending: ["approved", "denied", "cancelled", "expired"],',
    'pending: ["approved", "cancelled", "expired"],',
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, machine: reopened })),
    /Lean rejected source proof/,
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, machine: missing })),
    /Lean rejected source proof/,
  );
});

test("Lean rejects changed device, claim, agent, and resource graphs", async () => {
  const changes = [
    ["device", '["approved", "denied", "expired"]', '["denied", "expired"]'],
    ["claim", '["presented", "revoked", "expired"]', '["revoked", "expired"]'],
    [
      "agent",
      '["claimed", "claim_pending", "expired", "revoked"]',
      '["claimed", "expired", "revoked"]',
    ],
    ["resource", '["deleted", new Set()]', '["deleted", new Set(["active"])]'],
  ];
  for (const [key, before, after] of changes) {
    const graph = replaceOnce(sources.graphs[key], before, after);
    await assert.rejects(
      verifyProof(
        renderProof({
          ...sources,
          graphs: { ...sources.graphs, [key]: graph },
        }),
      ),
      /Lean rejected source proof/,
    );
  }
});

test("the translator refuses changed map lookup, graph mutation, and state domains", () => {
  const device = sources.graphs.device;
  const changes = [
    replaceOnce(
      device,
      "return ALLOWED.get(from)?.has(to) ?? false;",
      "return true;",
    ),
    `${device}\nALLOWED.get("pending")?.add("pending");\n`,
    `${device}\ncanTransitionDeviceAuth = () => true;\n`,
  ];
  for (const change of changes)
    assert.throws(
      () =>
        renderProof({
          ...sources,
          graphs: { ...sources.graphs, device: change },
        }),
      /Unsupported authentication source/,
    );
  const types = replaceOnce(
    sources.types,
    '  | "deleted"\n  | "quarantined";',
    '  | "deleted"\n  | "quarantined"\n  | "resurrected";',
  );
  assert.throws(() => renderProof({ ...sources, types }), /domain changed/);
});

test("the source translator refuses unmodeled methods, statements and URL comparisons", () => {
  const mutations = [
    replaceOnce(
      sources.cookie,
      '["GET", "HEAD", "OPTIONS"]',
      '["GET", "HEAD", "TRACE"]',
    ),
    replaceOnce(
      sources.cookie,
      "if (!origin) return false;",
      "doSideEffect(); if (!origin) return false;",
    ),
    replaceOnce(
      sources.cookie,
      "new URL(ctx.config.publicUrl).origin === origin",
      "origin === ctx.config.publicUrl",
    ),
    replaceOnce(
      sources.cookie,
      "if (!origin) return false;",
      "if (!origin) return origin;",
    ),
    `${sources.cookie}\ncookieAuthAllowed = () => true;\n`,
    `const URL = FakeURL;\n${sources.cookie}`,
  ];
  for (const cookie of mutations)
    assert.throws(
      () => renderProof({ ...sources, cookie }),
      /Unsupported authentication source/,
    );
});

test("the source translator refuses a redirected principal lookup or shadowed undefined", () => {
  const mutations = [
    replaceOnce(
      sources.cookie,
      "ctx.repos.principals.getById(principalId)",
      'ctx.repos.principals.getById("different")',
    ),
    `const undefined = null;\n${sources.cookie}`,
    `${sources.cookie}\nprincipalStillAuthenticates = async () => true;\n`,
  ];
  for (const cookie of mutations)
    assert.throws(
      () => renderProof({ ...sources, cookie }),
      /Unsupported authentication source/,
    );
});

test("the source translator refuses changed domains, table mutations and alternate lookups", () => {
  const types = replaceOnce(
    sources.types,
    '  | "expired"\n  | "cancelled";\n\n/**\n * Who settled a request.',
    '  | "expired"\n  | "cancelled"\n  | "reopened";\n\n/**\n * Who settled a request.',
  );
  assert.throws(
    () => renderProof({ ...sources, types }),
    /authorization status domain changed/,
  );
  const machines = [
    `${sources.machine}\nTRANSITIONS.pending.push("pending");\n`,
    replaceOnce(
      sources.machine,
      "return TRANSITIONS[from].includes(to);",
      "return true;",
    ),
    `${sources.machine}\ncanTransition = () => true;\n`,
    replaceOnce(
      sources.machine,
      'from "../types.js";',
      'from "../other-types.js";',
    ),
  ];
  for (const machine of machines)
    assert.throws(
      () => renderProof({ ...sources, machine }),
      /Unsupported authentication source/,
    );
});

test("a proof that uses sorry is rejected", async () => {
  const contract = replaceOnce(
    sources.contract,
    "  cases source <;> cases target <;> simp [extractedTransition, transitionPolicy]",
    "  sorry",
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, contract })),
    /Lean rejected source proof|Unexpected Lean audit output|unreviewed axiom/,
  );
});

test("the independent audit rejects a policy weakened to the implementation itself", async () => {
  let contract = replaceOnce(
    sources.contract,
    "safe = true ∨ (present = true ∧ (listed = true ∨ sameOrigin = some true))",
    "extractedCookie safe present listed sameOrigin = true",
  );
  contract = replaceOnce(
    contract,
    "  cases safe <;> cases present <;> cases listed <;> cases sameOrigin <;>\n    simp [extractedCookie, cookiePolicy]",
    "  rfl",
  );
  await assert.rejects(
    verifyProof(renderProof({ ...sources, contract })),
    /Lean rejected source proof/,
  );
});
