#!/usr/bin/env node
/** Exercise a staged npm package without registry publication or credentials. */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} local package proof failed`);
  return result.stdout;
}
export function localProofEnvironment(root) {
  const env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: root,
    NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    NPM_CONFIG_CACHE: join(root, "cache"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    // npm uses Node's trust store. Honor an explicitly configured extra CA
    // for enterprise proxies without forwarding tokens or NODE_OPTIONS.
    "NODE_EXTRA_CA_CERTS",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
  return env;
}

function runNpm(args, cwd, env) {
  // GitHub Actions exposes npm through a mise shim whose HOME and cwd must
  // point at the checkout. Invoke the npm paired with this Node directly so
  // the proof can use a separate HOME and working directory.
  const npmCli = realpathSync(join(dirname(process.execPath), "npm"));
  return run(process.execPath, [npmCli, ...args], cwd, env);
}

function requireValidIdentity(expectedName, expectedVersion, runCli) {
  if (
    ![NPM_PUBLISH.cli.name, NPM_PUBLISH.webPwa.name].includes(expectedName) ||
    !/^0\.0\.0-alpha\.(?:0|[1-9]\d*)$/u.test(expectedVersion) ||
    (runCli && expectedName !== NPM_PUBLISH.cli.name)
  )
    throw new Error("Invalid local package proof identity");
}

function packLocalPackage(
  packageDir,
  expectedName,
  expectedVersion,
  root,
  cwd,
  env,
) {
  const json = runNpm(
    [
      "pack",
      resolve(packageDir),
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
      "--prefix",
      cwd,
    ],
    cwd,
    env,
  );
  const packed = JSON.parse(json);
  const item =
    Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined;
  if (
    !item ||
    item.name !== expectedName ||
    item.version !== expectedVersion ||
    typeof item.filename !== "string" ||
    basename(item.filename) !== item.filename ||
    !Array.isArray(item.files)
  ) {
    throw new Error("Staged npm package identity does not match the release");
  }
  const paths = new Set(item.files.map((entry) => entry.path));
  const required =
    expectedName === NPM_PUBLISH.cli.name
      ? ["dist/bin.js"]
      : ["bin/serve.mjs", "dist/index.html"];
  if (required.some((path) => !paths.has(path)))
    throw new Error("Staged npm package is missing required files");
  return item;
}

function installAndCheckCli(root, cwd, env, filename, expectedVersion) {
  const install = join(root, "install");
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--prefix",
      install,
      join(root, filename),
    ],
    cwd,
    env,
  );
  const bin = join(install, "node_modules", ".bin", "opensesame");
  if (
    run(process.execPath, [bin, "--version"], cwd, {
      PATH: env.PATH,
      HOME: env.HOME,
    }).trim() !== expectedVersion
  ) {
    throw new Error("Staged CLI reported a different version");
  }
}

export function smokeLocalPackage(
  packageDir,
  expectedName,
  expectedVersion,
  runCli = false,
) {
  requireValidIdentity(expectedName, expectedVersion, runCli);
  const root = mkdtempSync(join(tmpdir(), "opensesame-npm-local-proof-"));
  try {
    const cwd = join(root, "cwd");
    mkdirSync(cwd);
    const env = localProofEnvironment(root);
    const item = packLocalPackage(
      packageDir,
      expectedName,
      expectedVersion,
      root,
      cwd,
      env,
    );
    if (runCli)
      installAndCheckCli(root, cwd, env, item.filename, expectedVersion);
    return { name: item.name, version: item.version };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    if (process.env.CD_PROOF_GATE_FAIL === "1")
      throw new Error("intentional promotion gate proof failure");
    const [directory, name, version, flag] = process.argv.slice(2);
    const result = smokeLocalPackage(
      directory,
      name,
      version,
      flag === "--run-cli",
    );
    process.stdout.write(
      `Local package proof passed for ${result.name}@${result.version}; registry publication is disabled.\n`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local package proof failed",
    );
    process.exitCode = 1;
  }
}
