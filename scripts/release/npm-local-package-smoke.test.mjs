import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  localProofEnvironment,
  smokeLocalPackage,
} from "./npm-local-package-smoke.mjs";

const version = "0.0.0-alpha.7";
const cliName = "@opensesame-labs/cli";
const pwaName = "@opensesame-labs/web-pwa";

test("the local npm environment keeps an explicit CA but drops credentials and Node options", (t) => {
  const root = mkdtempSync(join(tmpdir(), "npm-local-proof-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const values = {
    NODE_EXTRA_CA_CERTS: "/local/proxy-ca.pem",
    NODE_AUTH_TOKEN: "token-canary",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-canary",
    NODE_OPTIONS: "--require=/not-allowed.js",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, values);
    const env = localProofEnvironment(root);
    assert.equal(env.NODE_EXTRA_CA_CERTS, values.NODE_EXTRA_CA_CERTS);
    for (const key of [
      "NODE_AUTH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "NODE_OPTIONS",
    ])
      assert.equal(Object.hasOwn(env, key), false, key);
    delete process.env.NODE_EXTRA_CA_CERTS;
    assert.equal(
      Object.hasOwn(localProofEnvironment(root), "NODE_EXTRA_CA_CERTS"),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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

function fakeNodeToolchain(f, npmCli) {
  const toolchain = join(f.root, "node-toolchain");
  const bin = join(toolchain, "bin");
  const npmBin = join(toolchain, "lib/node_modules/npm/bin");
  const node = join(bin, "node");
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  symlinkSync(process.execPath, node);
  symlinkSync(npmCli, join(npmBin, "npm-cli.js"));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 88\n", { mode: 0o755 });
  return node;
}

function runProofWithNode(node, f) {
  const program = `
      import { pathToFileURL } from "node:url";
      Object.defineProperty(process, "execPath", { value: process.argv[1] });
      const { smokeLocalPackage } = await import(pathToFileURL(process.argv[2]).href);
      const result = smokeLocalPackage(process.argv[3], process.argv[4], process.argv[5]);
      if (result.name !== process.argv[4] || result.version !== process.argv[5]) process.exitCode = 1;
    `;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      program,
      node,
      join(import.meta.dirname, "npm-local-package-smoke.mjs"),
      f.root,
      pwaName,
      version,
    ],
    { encoding: "utf8" },
  );
}

test("uses Node's bundled npm CLI when mise replaces bin/npm with a shell shim", {
  skip: process.platform === "win32" ? "mise shim is POSIX-only" : false,
}, (t) => {
  const f = fixture(t, pwaName);
  const npmCli = resolve(
    dirname(process.execPath),
    "../lib/node_modules/npm/bin/npm-cli.js",
  );
  const result = runProofWithNode(fakeNodeToolchain(f, npmCli), f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.sentinel), false);
});

test("rejects malformed npm pack metadata before trusting its files", {
  skip: process.platform === "win32" ? "fixture uses POSIX symlinks" : false,
}, (t) => {
  const f = fixture(t, pwaName);
  const npmCli = join(f.root, "fake-npm-cli.cjs");
  writeFileSync(npmCli, "");
  const node = fakeNodeToolchain(f, npmCli);
  for (const item of [
    { name: pwaName, version, filename: "../escape.tgz", files: [] },
    { name: pwaName, version, filename: "release.tgz", files: [null] },
  ]) {
    writeFileSync(
      npmCli,
      `process.stdout.write(${JSON.stringify(JSON.stringify([item]))});`,
    );
    const result = runProofWithNode(node, f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity does not match/);
  }
  assert.equal(existsSync(f.sentinel), false);
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
