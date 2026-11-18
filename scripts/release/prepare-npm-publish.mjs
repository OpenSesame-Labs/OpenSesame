#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNpmContext,
  npmCli,
  npmConfigArgs,
  npmEnvironment,
} from "./npm-publish-isolation.mjs";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

const NAMES = new Set([NPM_PUBLISH.cli.name, NPM_PUBLISH.webPwa.name]);

function validatePublishConfig(config) {
  if (config === undefined) return;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) => !["access", "provenance"].includes(key),
    ) ||
    (config.access !== undefined && config.access !== "public") ||
    (config.provenance !== undefined && config.provenance !== true)
  )
    throw new Error("Unsupported npm publishConfig");
}

/** Do not allow the tarball's manifest to change npm's registry or behavior. */
export function validatePublishManifest(manifest, tag, expectedName) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !NAMES.has(manifest.name) ||
    manifest.name !== expectedName
  ) {
    throw new Error("Unsupported npm package name");
  }
  if (
    !(tag === "alpha" || tag === "next") ||
    typeof manifest.version !== "string" ||
    !new RegExp(`^0\\.0\\.0-${tag}\\.(?:0|[1-9]\\d*)$`, "u").test(
      manifest.version,
    )
  ) {
    throw new Error("Refusing invalid npm dist-tag or version");
  }
  validatePublishConfig(manifest.publishConfig);
  return { name: manifest.name, version: manifest.version, tag };
}

/** Hash the exact regular-file bytes npm will publish without buffering them all. */
export function tarballIntegrity(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("npm tarball must be a regular file");
    const hash = createHash("sha512");
    const block = Buffer.allocUnsafe(128 * 1024);
    while (true) {
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      hash.update(block.subarray(0, count));
    }
    return `sha512-${hash.digest("base64")}`;
  } finally {
    closeSync(fd);
  }
}

/** Pack and inspect before passing either the npm token or GitHub OIDC authority. */
export async function prepareNpmPublish(
  packageDirectory,
  tag,
  expectedName,
  temp = process.env.RUNNER_TEMP,
) {
  if (!temp || !isAbsolute(temp)) throw new Error("RUNNER_TEMP is required");
  const cli = npmCli();
  const root = mkdtempSync(join(temp, "opensesame-publish-"));
  try {
    const context = createNpmContext(root);
    const packed = spawnSync(
      process.execPath,
      [
        cli,
        "pack",
        resolve(packageDirectory),
        "--json",
        "--pack-destination",
        root,
        ...npmConfigArgs(context),
      ],
      {
        cwd: context.cwd,
        env: npmEnvironment(context),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (packed.status !== 0)
      throw new Error("npm could not pack the staged package");
    const metadata = JSON.parse(packed.stdout);
    const filename = metadata?.[0]?.filename;
    if (
      !Array.isArray(metadata) ||
      metadata.length !== 1 ||
      typeof filename !== "string" ||
      basename(filename) !== filename
    ) {
      throw new Error("npm returned invalid packed artifact metadata");
    }
    const packedFile = join(root, filename);
    if (!lstatSync(packedFile).isFile())
      throw new Error("npm tarball must be a regular file");
    const tarball = join(root, "package.tgz");
    renameSync(packedFile, tarball);
    // This is npm's own pinned tarball parser. It reads the frozen archive,
    // not a package.json that can be changed after this validation.
    const pacote = createRequire(cli)("pacote");
    const manifest = await pacote.manifest(tarball, {
      offline: true,
      ignoreScripts: true,
      cache: context.cache,
    });
    const identity = validatePublishManifest(manifest, tag, expectedName);
    const state = { ...identity, integrity: tarballIntegrity(tarball) };
    chmodSync(tarball, 0o400);
    writeFileSync(join(root, "state.json"), `${JSON.stringify(state)}\n`, {
      flag: "wx",
      mode: 0o400,
    });
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Only a directory created inside RUNNER_TEMP by the preparation step is accepted. */
export function readPreparedPublish(root, temp = process.env.RUNNER_TEMP) {
  if (!root || !temp || !isAbsolute(root) || !isAbsolute(temp))
    throw new Error("Prepared npm package is required");
  const parts = relative(temp, root).split(sep);
  if (
    parts.length !== 1 ||
    !/^opensesame-publish-[A-Za-z0-9]{6}$/u.test(parts[0]) ||
    !lstatSync(root).isDirectory()
  ) {
    throw new Error("Prepared npm package is required");
  }
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  validatePublishManifest(state, state.tag, state.name);
  const tarball = join(root, "package.tgz");
  if (state.integrity !== tarballIntegrity(tarball))
    throw new Error("Prepared npm tarball changed after validation");
  return { ...state, tarball, root };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    if (process.argv.length !== 5)
      throw new Error(
        "expected staged package directory, dist-tag, and package name",
      );
    const root = await prepareNpmPublish(
      process.argv[2],
      process.argv[3],
      process.argv[4],
    );
    process.stdout.write(`${root}\n`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "npm preparation failed",
    );
    process.exitCode = 1;
  }
}
