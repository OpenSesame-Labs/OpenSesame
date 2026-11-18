import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { smokeLocalPackage } from "./npm-local-package-smoke.mjs";

const version = "0.0.0-alpha.7";
const cliName = "@opensesame-labs/cli";
const pwaName = "@opensesame-labs/web-pwa";

function fixture(t, name) {
  const root = mkdtempSync(join(tmpdir(), "npm-local-proof-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  const sentinel = join(root, "script-ran");
  const hook = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')`)}`;
  const manifest = {
    name,
    version,
    files: ["dist", "bin"],
    scripts: { prepack: hook, preinstall: hook, postinstall: hook },
  };
  if (name === cliName) {
    manifest.bin = { opensesame: "dist/bin.js" };
    writeFileSync(
      join(root, "dist/bin.js"),
      `if(process.env.NODE_AUTH_TOKEN||process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)process.exit(9); console.log(${JSON.stringify(version)});\n`,
    );
  } else {
    manifest.bin = { "opensesame-pages": "bin/serve.mjs" };
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/serve.mjs"), "export {};\n");
    writeFileSync(join(root, "dist/index.html"), "<title>Pages</title>\n");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  return { root, sentinel };
}

test("installs and runs the staged CLI locally without lifecycle scripts or credentials", (t) => {
  const f = fixture(t, cliName);
  const previous = {
    token: process.env.NODE_AUTH_TOKEN,
    oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  process.env.NODE_AUTH_TOKEN = "secret-canary";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-canary";
  try {
    assert.deepEqual(smokeLocalPackage(f.root, cliName, version, true), {
      name: cliName,
      version,
    });
    assert.equal(existsSync(f.sentinel), false);
    assert.throws(
      () => smokeLocalPackage(f.root, cliName, "0.0.0-alpha.8"),
      /identity/,
    );
  } finally {
    if (previous.token === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previous.token;
    if (previous.oidc === undefined)
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previous.oidc;
  }
});

test("checks that the staged PWA tarball includes its server and Pages payload", (t) => {
  const f = fixture(t, pwaName);
  assert.deepEqual(smokeLocalPackage(f.root, pwaName, version), {
    name: pwaName,
    version,
  });
  rmSync(join(f.root, "dist/index.html"));
  assert.throws(
    () => smokeLocalPackage(f.root, pwaName, version),
    /missing required files/,
  );
  assert.equal(existsSync(f.sentinel), false);
});

test("uses Node's paired npm outside the checkout instead of a PATH shim", (t) => {
  const f = fixture(t, pwaName);
  const shim = join(f.root, "shims");
  mkdirSync(shim);
  writeFileSync(join(shim, "npm"), "#!/bin/sh\nexit 88\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim}${delimiter}${previousPath ?? ""}`;
  try {
    assert.deepEqual(smokeLocalPackage(f.root, pwaName, version), {
      name: pwaName,
      version,
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("the intentional smoke failure blocks the local proof", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "npm-local-package-smoke.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, CD_PROOF_GATE_FAIL: "1" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /intentional promotion gate proof failure/);
});
