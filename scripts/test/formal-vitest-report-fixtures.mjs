import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));
const file = {
  auth: "spec/formal/auth/auth-conformance.test.ts",
  oauth: "spec/formal/oauth/legacy-conformance.test.ts",
  security:
    "packages/control-plane/src/interactions/federated-pending.security.test.ts",
  webauthn: "spec/formal/webauthn/approval-conformance.test.ts",
};
const bits = ["0", "1"];
const assurance = [
  "missing",
  "provisional",
  "self_asserted",
  "verified",
  "mfa",
  "phishing_resistant",
  "enterprise_managed",
  "workload_attested",
];
const states = ["provisional", "active", "expired", "deleting", "deleted"];
const sessionPrincipals = [
  "missing",
  "provisional",
  "active",
  "suspended",
  "closed",
];
const approvalKinds = [
  "device_authorization",
  "pairing",
  "claim",
  "grant_claim",
  "authorization_request",
  "transaction_authorization",
];
const approvalStates = [
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
];
const digest = ["absent", "empty", "a", "b"];

function rows(axes, prefix, outputs) {
  let result = [[]];
  for (const axis of axes)
    result = result.flatMap((row) => axis.map((value) => [...row, value]));
  const resultValues = Array.isArray(outputs)
    ? outputs
    : Array(outputs).fill("0");
  return result.map((row) => [prefix, ...row, ...resultValues]);
}

function assertion(title, ancestors = []) {
  return {
    title,
    ancestorTitles: ancestors,
    fullName: [...ancestors, title].join(" "),
    status: "passed",
    failureMessages: [],
  };
}

function fileResult(path, assertions) {
  return {
    name: resolve(root, path),
    status: "passed",
    assertionResults: assertions,
  };
}

function authFixture() {
  const vectors = [
    ...rows([assurance], "principal", ["not_found"]),
    ...rows(
      [bits, bits, bits, ["past", "equal", "future"], bits, sessionPrincipals],
      "session",
      1,
    ),
    ...rows(
      [
        bits,
        states,
        ["none", "past", "equal", "future"],
        ["none", "member", "admin", "owner"],
      ],
      "project",
      ["denied", "0", "0", "0"],
    ),
  ];
  const ancestor = ["Lean auth policy correspondence"];
  const tests = [
    assertion("contains every declared abstract case exactly once", ancestor),
  ];
  tests.push(
    ...vectors
      .filter((row) => row[0] === "session")
      .map((row) =>
        assertion(`session ${row.slice(0, 7).join(" ")}`, ancestor),
      ),
  );
  tests.push(
    ...assurance.map((value) =>
      assertion(`principal principal ${value}`, ancestor),
    ),
  );
  tests.push(
    ...vectors
      .filter((row) => row[0] === "project")
      .map((row) =>
        assertion(`project ${row.slice(0, 5).join(" ")}`, ancestor),
      ),
  );
  return finishFixture(vectors, [fileResult(file.auth, tests)]);
}

function securityCase(fullName) {
  const group = "signed federated state integrity";
  const prefix = `${group} `;
  if (fullName.startsWith(prefix))
    return assertion(fullName.slice(prefix.length), [group]);
  return assertion(fullName);
}

function oauthFixture() {
  const legacy = rows([bits, bits, bits, bits, bits], "legacy", 1);
  const provenance = rows(
    [
      ["0", "1", "2"],
      ["-", "1", "2"],
      ["-", "1", "2"],
      ["-", "1", "2"],
    ],
    "provenance",
    1,
  );
  const tests = [
    assertion("covers every abstract legacy MAC and provenance case"),
    assertion("covers every sampled source and pending provenance combination"),
  ];
  tests.push(
    ...legacy.map((row) =>
      assertion(`legacy provenance ${row.slice(0, 6).join(" ")}`),
    ),
  );
  tests.push(
    ...provenance.map((row) =>
      assertion(`current provenance ${row.slice(0, 5).join(" ")}`),
    ),
  );
  const security = [
    "signed federated state integrity round-trips a signed state with its organization and upstream context",
    "signed federated state integrity seals the verifier on the wire with a fresh GCM IV per cookie",
    ...[
      "issuer",
      "state",
      "nonce",
      "kind",
      "providerId",
      "byoId",
      "orgId",
      "future field",
    ].map(
      (field) => `signed federated state integrity rejects a changed ${field}`,
    ),
    "signed federated state integrity rejects a tampered or swapped verifier seal",
    "signed federated state integrity rejects decoding with the wrong pepper",
    "signed federated state integrity fails closed on a plaintext or mixed verifier even under a valid v4 tag",
    "signed federated state integrity refuses a v3 cookie that main emitted before v4",
    "signed federated state integrity refuses v3 plaintext and legacy signatures, so their sign-ins restart",
    "signed federated state integrity derives no key and runs no slow hash before the MAC verifies",
    "signed federated state integrity keeps slow password hashing out of the pending cookie codec",
    ...["orgId", "byoId"].map(
      (field) =>
        `refuses a stripped legacy ${field} callback before trust lookup or exchange`,
    ),
    "binds OAuth2 callbacks to the same static OAuth2 provider",
    "refuses a changed trust owner at the exchange's own lookup",
  ].map(securityCase);
  return finishFixture(
    [...legacy, ...provenance],
    [fileResult(file.oauth, tests), fileResult(file.security, security)],
  );
}

function webauthnFixture() {
  const vectors = rows(
    [
      approvalKinds,
      approvalStates,
      ["invalid", "valid"],
      ["invalid", "past", "equal", "future"],
      digest,
      ["empty", "a", "b", "other"],
    ],
    "approval",
    1,
  );
  const ancestor = ["Lean approval binding correspondence"];
  const names = [
    "refuses an operation whose present request digest and proof digest are empty",
    "retains digest-free approval for session-only interaction kinds",
    "contains every declared abstract case exactly once",
  ];
  const tests = names.map((name) => assertion(name, ancestor));
  tests.push(
    ...vectors.map((row) =>
      assertion(`approval ${row.slice(0, 7).join(" ")}`, ancestor),
    ),
  );
  return finishFixture(vectors, [fileResult(file.webauthn, tests)]);
}

function finishFixture(vectors, files) {
  const total = files.reduce(
    (count, item) => count + item.assertionResults.length,
    0,
  );
  return {
    vectors: `${vectors.map((row) => row.join("\t")).join("\n")}\n`,
    report: {
      success: true,
      numTotalTests: total,
      numPassedTests: total,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: files,
    },
  };
}

export function fixture(suite) {
  if (suite === "auth") return authFixture();
  if (suite === "oauth") return oauthFixture();
  if (suite === "webauthn") return webauthnFixture();
  throw new Error(`unknown fixture: ${suite}`);
}
