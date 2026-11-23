#!/usr/bin/env node
/** Fail closed if the required Lean-to-implementation checks did not run. */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

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
const projectStates = [
  "provisional",
  "active",
  "expired",
  "deleting",
  "deleted",
];
const projectExpiries = ["none", "past", "equal", "future"];
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
const digestCases = ["absent", "empty", "a", "b"];
const proofCases = ["empty", "a", "b", "other"];

const matrices = {
  auth: {
    principal: {
      axes: [assurance],
      outputs: [["not_found", "provisional", "admitted"]],
    },
    session: {
      axes: [
        bits,
        bits,
        bits,
        ["past", "equal", "future"],
        bits,
        sessionPrincipals,
      ],
      outputs: [bits],
    },
    project: {
      axes: [
        bits,
        projectStates,
        projectExpiries,
        ["none", "member", "admin", "owner"],
      ],
      outputs: [["denied", "member", "admin", "owner"], bits, bits, bits],
    },
  },
  oauth: {
    legacy: { axes: [bits, bits, bits, bits, bits], outputs: [bits] },
    provenance: {
      axes: [
        ["0", "1", "2"],
        ["-", "1", "2"],
        ["-", "1", "2"],
        ["-", "1", "2"],
      ],
      outputs: [bits],
    },
  },
  webauthn: {
    approval: {
      axes: [
        approvalKinds,
        approvalStates,
        ["invalid", "valid"],
        ["invalid", "past", "equal", "future"],
        digestCases,
        proofCases,
      ],
      outputs: [bits],
    },
  },
};

const oauthSecurityNames = [
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
];
const approvalNames = [
  "refuses an operation whose present request digest and proof digest are empty",
  "retains digest-free approval for session-only interaction kinds",
  "contains every declared abstract case exactly once",
].map((name) => `Lean approval binding correspondence ${name}`);
function fail(message) {
  throw new Error(message);
}
function product(axes) {
  return axes.reduce(
    (rows, axis) => rows.flatMap((row) => axis.map((value) => [...row, value])),
    [[]],
  );
}

function sameSet(actual, expected, label) {
  const unique = new Set(actual);
  if (
    actual.length !== expected.length ||
    unique.size !== expected.length ||
    expected.some((value) => !unique.has(value))
  ) {
    const expectedSet = new Set(expected);
    fail(
      `${label}: expected every required case exactly once; missing=${JSON.stringify(expected.find((value) => !unique.has(value)))} unexpected=${JSON.stringify(actual.find((value) => !expectedSet.has(value)))} actual=${actual.length} unique=${unique.size} expected=${expected.length}`,
    );
  }
}
function parseVectors(suite, text) {
  const schema = matrices[suite];
  if (!schema || !isString(text) || text.length === 0)
    fail("unknown suite or empty vector file");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0 || line.includes("\r")))
    fail("empty or malformed vector row");
  const groups = Object.fromEntries(
    Object.keys(schema).map((key) => [key, []]),
  );
  for (const line of lines) {
    const row = line.split("\t");
    const group = schema[row[0]];
    if (!group || row.length !== 1 + group.axes.length + group.outputs.length)
      fail("unexpected vector row");
    if (
      group.outputs.some(
        (domain, index) => !domain.includes(row[1 + group.axes.length + index]),
      )
    )
      fail(`${suite} ${row[0]} vector has invalid output`);
    groups[row[0]].push(row.slice(1, 1 + group.axes.length).join("/"));
  }
  for (const [name, group] of Object.entries(schema)) {
    sameSet(
      groups[name],
      product(group.axes).map((row) => row.join("/")),
      `${suite} ${name} vectors`,
    );
  }
  return groups;
}
function checkSummary(report, expectedTotal, expectedFiles) {
  if (
    report?.success !== true ||
    report.numTotalTests !== expectedTotal ||
    report.numPassedTests !== expectedTotal ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== expectedFiles
  ) {
    fail("Vitest report is missing, incomplete, skipped, or unsuccessful");
  }
}

function checkAssertion(test, path) {
  if (
    test?.status !== "passed" ||
    !isString(test.title) ||
    !isString(test.fullName) ||
    !Array.isArray(test.ancestorTitles) ||
    test.ancestorTitles.some((title) => !isString(title)) ||
    test.fullName !== [...test.ancestorTitles, test.title].join(" ") ||
    !Array.isArray(test.failureMessages) ||
    test.failureMessages.length !== 0
  ) {
    fail(`test in ${path} did not pass cleanly`);
  }
}

function checkFile(file) {
  if (
    !isString(file?.name) ||
    !isAbsolute(file.name) ||
    file.status !== "passed" ||
    !Array.isArray(file.assertionResults)
  )
    fail("invalid test file result");
}
function fileResults(report, root, paths, expectedTotal) {
  checkSummary(report, expectedTotal, paths.length);
  const expected = new Map(
    paths.map((path) => [realpathSync(resolve(root, path)), path]),
  );
  const results = new Map();
  for (const file of report.testResults) {
    checkFile(file);
    const path = expected.get(realpathSync(file.name));
    if (!path || results.has(path)) fail("unexpected or duplicate test file");
    for (const test of file.assertionResults) checkAssertion(test, path);
    results.set(path, file.assertionResults);
  }
  if (results.size !== paths.length) fail("required test file missing");
  return results;
}

function checkAuth(tests, vectors) {
  if (
    tests.length !== 409 ||
    tests.some(
      (test) =>
        test.ancestorTitles.length !== 1 ||
        test.ancestorTitles[0] !== "Lean auth policy correspondence",
    )
  ) {
    fail("auth correspondence suite is incomplete");
  }
  const inventory = tests.filter(
    (test) =>
      test.title === "contains every declared abstract case exactly once",
  );
  const sessions = tests.filter((test) => test.title.startsWith("session "));
  const principals = tests.filter((test) =>
    test.title.startsWith("principal "),
  );
  const projects = tests.filter((test) => test.title.startsWith("project "));
  if (
    inventory.length !== 1 ||
    sessions.length !== 240 ||
    principals.length !== 8 ||
    projects.length !== 160
  ) {
    fail("auth inventory or correspondence group counts do not match");
  }
  sameSet(
    sessions.map((test) => test.title),
    vectors.session.map(
      (value) => `session session ${value.replaceAll("/", " ")}`,
    ),
    "auth session tests",
  );
  sameSet(
    principals.map((test) => test.title),
    vectors.principal.map((value) => `principal principal ${value}`),
    "auth principal tests",
  );
  sameSet(
    projects.map((test) => test.title),
    vectors.project.map(
      (value) => `project project ${value.replaceAll("/", " ")}`,
    ),
    "auth project tests",
  );
}

function checkOauth(tests, security, vectors) {
  const named = tests.filter(
    (test) =>
      !test.title.startsWith("legacy provenance ") &&
      !test.title.startsWith("current provenance "),
  );
  sameSet(
    named.map((test) => test.fullName),
    [
      "covers every abstract legacy MAC and provenance case",
      "covers every sampled source and pending provenance combination",
    ],
    "oauth inventories",
  );
  sameSet(
    tests
      .filter((test) => test.title.startsWith("legacy provenance "))
      .map((test) => test.fullName),
    vectors.legacy.map(
      (key) => `legacy provenance legacy ${key.replaceAll("/", " ")}`,
    ),
    "oauth legacy tests",
  );
  sameSet(
    tests
      .filter((test) => test.title.startsWith("current provenance "))
      .map((test) => test.fullName),
    vectors.provenance.map(
      (key) => `current provenance provenance ${key.replaceAll("/", " ")}`,
    ),
    "oauth provenance tests",
  );
  sameSet(
    security.map((test) => test.fullName),
    oauthSecurityNames,
    "oauth security tests",
  );
}

export function verifyFormalVitestReport(suite, report, vectorText, root) {
  const vectors = parseVectors(suite, vectorText);
  if (suite === "auth") {
    const path = "spec/formal/auth/auth-conformance.test.ts";
    checkAuth(fileResults(report, root, [path], 409).get(path), vectors);
  } else if (suite === "oauth") {
    const path = "spec/formal/oauth/legacy-conformance.test.ts";
    const security =
      "packages/control-plane/src/interactions/federated-pending.security.test.ts";
    const files = fileResults(report, root, [path, security], 136);
    checkOauth(files.get(path), files.get(security), vectors);
  } else if (suite === "webauthn") {
    const path = "spec/formal/webauthn/approval-conformance.test.ts";
    const tests = fileResults(report, root, [path], 6147).get(path);
    if (
      tests.some(
        (test) =>
          test.ancestorTitles.length !== 1 ||
          test.ancestorTitles[0] !== "Lean approval binding correspondence",
      )
    )
      fail("webauthn correspondence suite is incomplete");
    sameSet(
      tests
        .filter((test) => !test.title.startsWith("approval "))
        .map((test) => test.fullName),
      approvalNames,
      "webauthn fixed tests",
    );
    sameSet(
      tests
        .filter((test) => test.title.startsWith("approval "))
        .map((test) => test.title),
      vectors.approval.map(
        (value) => `approval approval ${value.replaceAll("/", " ")}`,
      ),
      "webauthn approval tests",
    );
  } else {
    fail(`unknown formal suite ${suite}`);
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [suite, reportPath, vectorPath, root, ...extra] =
      process.argv.slice(2);
    if (!suite || !reportPath || !vectorPath || !root || extra.length)
      fail("usage: formal-vitest-report.mjs SUITE REPORT VECTORS ROOT");
    verifyFormalVitestReport(
      suite,
      JSON.parse(readFileSync(reportPath, "utf8")),
      readFileSync(vectorPath, "utf8"),
      root,
    );
    console.log(`formal-vitest-report: ${suite} correspondence checks passed`);
  } catch (error) {
    console.error(
      `formal-vitest-report: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
