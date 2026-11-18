import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyNpmPublishResult,
  isForbiddenRepublishOfVersion,
  npmTrunkPublish,
  npmViewVersion,
} from "./npm-trunk-publish.mjs";

const version = "0.0.0-alpha.23";
const forbidden = `npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@opensesame-labs%2fcli - You cannot publish over the previously published versions: 0.0.0-alpha.23.`;

test("isForbiddenRepublishOfVersion matches trunk CD 403 body", () => {
  assert.equal(isForbiddenRepublishOfVersion(forbidden, version), true);
  assert.equal(
    isForbiddenRepublishOfVersion(forbidden, "0.0.0-alpha.24"),
    false,
  );
  assert.equal(isForbiddenRepublishOfVersion("npm error 404", version), false);
});

test("classifyNpmPublishResult maps E403 republish to already_published", () => {
  assert.equal(
    classifyNpmPublishResult(
      { status: 1, stdout: "", stderr: forbidden },
      version,
    ),
    "already_published",
  );
  assert.equal(
    classifyNpmPublishResult({ status: 0, stdout: "", stderr: "" }, version),
    "published",
  );
  assert.equal(
    classifyNpmPublishResult(
      { status: 1, stdout: "", stderr: "npm error 401" },
      version,
    ),
    "failed",
  );
});

const input = {
  packageName: "@opensesame-labs/cli",
  version,
  distTag: "alpha",
  cwd: ".",
};

test("a 403 republish is confirmed even when the registry's read side lags", () => {
  // The incident: the view missed, the publish was refused as a republish.
  // The first views after the 403 can miss for the same reason.
  const views = [undefined, undefined, undefined, version];
  const waits = [];
  const result = npmTrunkPublish(input, {
    view: () => views.shift(),
    publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
    wait: (ms) => waits.push(ms),
  });
  assert.equal(result.outcome, "already_published");
  assert.equal(result.confirmAfter403, version);
  assert.equal(waits.length, 2);
  assert.equal(views.length, 0);
});

test("a 403 the registry never confirms is a failure, not a success", () => {
  let asked = 0;
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => {
          asked += 1;
          return undefined;
        },
        publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
        wait: () => {},
      }),
    /already published but registry view got missing/,
  );
  // One view before the publish, then a bounded number after it.
  assert.equal(asked, 7);
});

test("a version already on the registry is never published again", () => {
  let published = 0;
  const result = npmTrunkPublish(input, {
    view: () => version,
    publish: () => {
      published += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    wait: () => {},
  });
  assert.equal(result.outcome, "already_published");
  assert.equal(published, 0);
});

test("any other publish failure still fails", () => {
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => undefined,
        publish: () => ({ status: 1, stdout: "", stderr: "npm error 401" }),
        wait: () => {},
      }),
    /npm error 401/,
  );
});

test("view and publish use the local CLI with scripts off and preserve auth", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-npm-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(
    dir,
    "opensesame-npm-AB12cd34",
    "extracted/package/bin/npm-cli.js",
  );
  const log = join(dir, "calls.jsonl");
  mkdirSync(join(dir, "opensesame-npm-AB12cd34/extracted/package/bin"), {
    recursive: true,
  });
  writeFileSync(
    cli,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OPENSESAME_TEST_NPM_LOG, JSON.stringify({
  args,
  token: process.env.NODE_AUTH_TOKEN === 'unit-token',
  oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'unit-oidc',
  ignore: process.env.NPM_CONFIG_IGNORE_SCRIPTS,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodePath: process.env.NODE_PATH ?? null,
  duplicateToken: process.env.NPM_TOKEN_INPUT ?? null,
}) + '\\n');
if (args[0] === 'view') process.stdout.write('0.0.0-alpha.23\\n');
`,
  );
  const values = {
    OPENSESAME_NPM_CLI: cli,
    RUNNER_TEMP: dir,
    OPENSESAME_TEST_NPM_LOG: log,
    NODE_AUTH_TOKEN: "unit-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "unit-oidc",
    NODE_OPTIONS: "--require /does-not-exist",
    NODE_PATH: "/does-not-exist",
    NPM_TOKEN_INPUT: "duplicate-token",
  };
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    assert.equal(npmViewVersion(input.packageName, version), version);
    assert.equal(
      npmTrunkPublish({ ...input, cwd: dir }, { view: () => undefined })
        .outcome,
      "published",
    );
    delete process.env.NODE_AUTH_TOKEN;
    assert.equal(
      npmTrunkPublish({ ...input, cwd: dir }, { view: () => undefined })
        .outcome,
      "published",
    );
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[0], "view");
  assert.deepEqual(calls[1].args, [
    "publish",
    "--ignore-scripts",
    "--access",
    "public",
    "--tag",
    "alpha",
    "--provenance",
  ]);
  for (const call of calls) {
    assert.ok(call.args.includes("--ignore-scripts"));
    assert.equal(call.ignore, "true");
    assert.equal(call.oidc, true);
    assert.equal(call.nodeOptions, null);
    assert.equal(call.nodePath, null);
    assert.equal(call.duplicateToken, null);
  }
  assert.equal(calls[0].token, true);
  assert.equal(calls[1].token, true);
  assert.equal(calls[2].token, false);
  assert.deepEqual(calls[2].args, calls[1].args);
});

test("the publish path refuses an absent or unprepared CLI", () => {
  const original = process.env.OPENSESAME_NPM_CLI;
  const originalTemp = process.env.RUNNER_TEMP;
  try {
    process.env.RUNNER_TEMP = tmpdir();
    for (const value of [
      undefined,
      "npm-cli.js",
      "/tmp/unverified/npm-cli.js",
    ]) {
      if (value === undefined) delete process.env.OPENSESAME_NPM_CLI;
      else process.env.OPENSESAME_NPM_CLI = value;
      assert.throws(
        () => npmViewVersion(input.packageName, version),
        /verified npm CLI/,
      );
    }
  } finally {
    if (original === undefined) delete process.env.OPENSESAME_NPM_CLI;
    else process.env.OPENSESAME_NPM_CLI = original;
    if (originalTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = originalTemp;
  }
});
