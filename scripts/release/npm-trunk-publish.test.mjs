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
import { createNpmContext } from "./npm-publish-isolation.mjs";
import {
  classifyNpmPublishResult,
  isForbiddenRepublishOfVersion,
  npmTrunkPublish,
  npmViewIntegrity,
} from "./npm-trunk-publish.mjs";

const version = "0.0.0-alpha.23";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const otherIntegrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
const forbidden = `npm error code E403\nnpm error 403 Forbidden - You cannot publish over the previously published versions: ${version}.`;
const input = {
  packageName: "@opensesame-labs/cli",
  version,
  distTag: "alpha",
  tarball: "/tmp/frozen.tgz",
  integrity,
};

test("duplicate publication is recognized without treating other failures as duplicates", () => {
  assert.equal(isForbiddenRepublishOfVersion(forbidden, version), true);
  assert.equal(
    isForbiddenRepublishOfVersion(forbidden, "0.0.0-alpha.24"),
    false,
  );
  assert.equal(
    isForbiddenRepublishOfVersion(
      `You cannot publish over the previously published versions: ${version}.`,
      version,
    ),
    true,
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

test("an already-published version is accepted only with the frozen tarball's integrity", () => {
  let published = 0;
  const publish = () => {
    published += 1;
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(
    npmTrunkPublish(input, { view: () => integrity, publish }).outcome,
    "already_published",
  );
  assert.equal(published, 0);
  assert.throws(
    () => npmTrunkPublish(input, { view: () => otherIntegrity, publish }),
    /different integrity/,
  );
  assert.equal(published, 0);
});

test("a duplicate publish is checked after read-side lag, including byte mismatch", () => {
  const waits = [];
  const views = [undefined, undefined, undefined, integrity];
  const result = npmTrunkPublish(input, {
    view: () => views.shift(),
    publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
    wait: (ms) => waits.push(ms),
  });
  assert.equal(result.outcome, "already_published");
  assert.equal(result.confirmAfter403, integrity);
  assert.equal(waits.length, 2);
  let calls = 0;
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => (++calls === 1 ? undefined : otherIntegrity),
        publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
        wait: () => {},
      }),
    /different integrity/,
  );
});

test("unavailable integrity or unrelated publish errors never count as success", () => {
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => undefined,
        publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
        wait: () => {},
      }),
    /integrity was unavailable/,
  );
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => {
          throw new Error("registry unavailable");
        },
      }),
    /registry unavailable/,
  );
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => undefined,
        publish: () => ({ status: 1, stdout: "", stderr: "npm error 401" }),
      }),
    /publish failed/,
  );
});

function assertNpmCalls(calls, context) {
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[0], "view");
  assert.equal(calls[0].env.token, null);
  assert.equal(calls[0].env.oidc, null);
  assert.equal(calls[0].env.userconfig, context.anonymous);
  assert.equal(calls[1].env.token, "unit-token");
  assert.equal(calls[1].env.oidc, "unit-oidc");
  assert.equal(calls[1].env.userconfig, context.authenticated);
  assert.equal(calls[2].env.token, null);
  assert.equal(calls[2].env.oidc, "unit-oidc");
  assert.equal(calls[2].env.userconfig, context.anonymous);
  for (const call of calls) {
    assert.equal(call.cwd, context.cwd);
    assert.ok(call.args.includes("--ignore-scripts"));
    assert.equal(call.args[call.args.indexOf("--prefix") + 1], context.cwd);
    assert.equal(
      call.args[call.args.indexOf("--registry") + 1],
      "https://registry.npmjs.org/",
    );
    assert.equal(call.env.globalconfig, context.global);
    assert.equal(call.env.ignore, "true");
    assert.equal(call.env.registryOverride, null);
    assert.equal(call.env.nodeOptions, null);
    assert.equal(call.env.nodePath, null);
    assert.equal(call.env.duplicateToken, null);
  }
  assert.equal(calls[1].args[0], "publish");
  assert.equal(calls[1].args[1], input.tarball);
  assert.ok(calls[1].args.includes("--provenance"));
}

test("view is anonymous and publish gets only explicitly scoped npm and OIDC settings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-npm-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(
    dir,
    "opensesame-npm-AB12cd34/extracted/package/bin/npm-cli.js",
  );
  const log = join(dir, "calls.jsonl");
  mkdirSync(join(dir, "opensesame-npm-AB12cd34/extracted/package/bin"), {
    recursive: true,
  });
  writeFileSync(
    cli,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd: process.cwd(), env: {
 token: process.env.NODE_AUTH_TOKEN ?? null,
 oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? null,
 userconfig: process.env.NPM_CONFIG_USERCONFIG,
 globalconfig: process.env.NPM_CONFIG_GLOBALCONFIG,
 ignore: process.env.NPM_CONFIG_IGNORE_SCRIPTS,
 registryOverride: process.env.npm_config_registry ?? null,
 nodeOptions: process.env.NODE_OPTIONS ?? null, nodePath: process.env.NODE_PATH ?? null,
 duplicateToken: process.env.NPM_TOKEN_INPUT ?? null,
}}) + '\\n');
if (args[0] === 'view') process.stdout.write(JSON.stringify(${JSON.stringify(integrity)}) + '\\n');
`,
  );
  const context = createNpmContext(join(dir, "isolation"));
  const values = {
    OPENSESAME_NPM_CLI: cli,
    RUNNER_TEMP: dir,
    NODE_AUTH_TOKEN: "unit-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "unit-oidc",
    NPM_TOKEN_INPUT: "duplicate-token",
    NODE_OPTIONS: "--require /does-not-exist",
    NODE_PATH: "/does-not-exist",
    npm_config_registry: "https://attacker.example/",
  };
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    assert.equal(
      npmViewIntegrity(input.packageName, version, context),
      integrity,
    );
    assert.equal(
      npmTrunkPublish({ ...input, context }, { view: () => undefined }).outcome,
      "published",
    );
    delete process.env.NODE_AUTH_TOKEN;
    assert.equal(
      npmTrunkPublish({ ...input, context }, { view: () => undefined }).outcome,
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
  assertNpmCalls(calls, context);
});

test("the publish path refuses an absent or unprepared CLI", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-npm-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = createNpmContext(dir);
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
        () => npmViewIntegrity(input.packageName, version, context),
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
