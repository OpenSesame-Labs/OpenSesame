import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  issuedToken,
  manifest,
  oidcJwt,
  oidcToken,
  runFixture,
  setupFixture,
  staticToken,
} from "./fixtures/npm-publish-isolation-support.mjs";

const pinnedCli = process.env.OPENSESAME_TEST_NPM_CLI;

async function exerciseCredentialModes(state) {
  let frozenIntegrity;
  for (state.mode of ["token", "oidc"]) {
    const child = await runFixture(
      [state.packageDirectory, state.goodRegistry, state.mode],
      state.env,
    );
    assert.equal(
      child.code,
      0,
      `${child.stderr}\nrequests=${JSON.stringify(state.requests)}`,
    );
    const line = child.stdout
      .split("\n")
      .find((item) => item.startsWith("RESULT "));
    assert.ok(line, child.stdout);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(result.observed, result.integrity);
    if (frozenIntegrity)
      assert.equal(
        result.integrity,
        frozenIntegrity,
        "repacking unchanged bytes must be deterministic",
      );
    frozenIntegrity = result.integrity;
    assert.equal(result.result.outcome, "stopped");
    assert.match(result.result.error, /npm publish failed/);
  }
  assert.equal(
    existsSync(state.hook),
    false,
    "npm must not run package lifecycle scripts",
  );
  for (const mode of ["token", "oidc"]) {
    const own = state.requests.filter((request) => request.mode === mode);
    assert.ok(
      own.some(
        (request) =>
          request.url.startsWith("/oidc") &&
          request.auth === `Bearer ${oidcToken}`,
      ),
    );
    assert.ok(
      own.some(
        (request) =>
          request.url.startsWith("/-/npm/v1/oidc/token/exchange/") &&
          request.auth === `Bearer ${oidcJwt}`,
      ),
    );
    assert.ok(
      own.some(
        (request) =>
          request.url.includes("opensesame-labs") &&
          request.auth ===
            `Bearer ${mode === "token" ? staticToken : issuedToken}`,
      ),
    );
    assert.ok(
      own.some(
        (request) => request.url.includes("opensesame-labs") && !request.auth,
      ),
      "registry view should be anonymous",
    );
  }
  assert.deepEqual(
    state.attackRequests,
    [],
    "artifact-controlled registry received a request",
  );
}
async function exerciseRefusals(state) {
  for (const mode of ["missing", "version-missing"]) {
    state.mode = mode;
    const missing = await runFixture(
      [state.packageDirectory, state.goodRegistry, mode],
      state.env,
    );
    assert.equal(missing.code, 0, missing.stderr);
    assert.match(missing.stdout, /"observed":null/);
  }
  state.mode = "no-integrity";
  const noIntegrity = await runFixture(
    [state.packageDirectory, state.goodRegistry, state.mode],
    state.env,
  );
  assert.notEqual(noIntegrity.code, 0);
  assert.match(
    noIntegrity.stderr,
    /npm registry returned (invalid|no) integrity/,
  );
  writeFileSync(
    join(state.packageDirectory, "package.json"),
    JSON.stringify(
      manifest({
        publishConfig: {
          "@opensesame-labs:registry": state.badRegistry,
          [`//${new URL(state.badRegistry).host}/:_authToken`]:
            "${NODE_AUTH_TOKEN}",
        },
      }),
    ),
  );
  const refused = await runFixture(
    [state.packageDirectory, state.goodRegistry, "malicious-manifest"],
    state.env,
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Unsupported npm publishConfig/);
  assert.deepEqual(state.attackRequests, []);
}

test("pinned npm isolates package, home, environment, and manifest registry attacks", {
  skip: !pinnedCli,
}, async (t) => {
  const state = await setupFixture(t, pinnedCli);
  await exerciseCredentialModes(state);
  await exerciseRefusals(state);
});
