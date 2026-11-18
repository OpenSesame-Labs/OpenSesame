#!/usr/bin/env node
// Verify npm's immutable tarball before extracting or executing any of it.
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NPM_VERSION = "11.21.1";
export const NPM_SHA512 =
  "613ccbe90044257c87713bb426251ced128ca7e9b3949b65eeb18b98445a5d441e14720c73d6ad76be86f4cf42f2f0d66efe347a9a13400ccd2f6fcfb5954385";
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const extractor = fileURLToPath(new URL("./archive-safe.py", import.meta.url));

/** The verifier and version probe never need publication authority. */
function unprivilegedEnv(staging) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/nonexistent",
    NPM_CONFIG_USERCONFIG: join(staging, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(staging, "global.npmrc"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
}

/**
 * Read once through a non-symlink file descriptor, then validate the exact
 * bytes that will be given to the safe archive extractor.
 * @param {string} archive
 * @returns {Buffer}
 */
function verifiedBytes(archive) {
  const descriptor = openSync(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TARBALL_BYTES) {
      throw new Error("npm tarball is not a bounded regular file");
    }
    // One extra byte detects growth without ever reading an unbounded file.
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (count === 0) break;
      used += count;
    }
    if (used !== stat.size) {
      throw new Error("npm tarball size changed during verification");
    }
    const bytes = buffer.subarray(0, used);
    const expected = Buffer.from(NPM_SHA512, "hex");
    const actual = createHash("sha512").update(bytes).digest();
    if (!timingSafeEqual(actual, expected)) {
      throw new Error("npm tarball failed the committed SHA-512 check");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Extract only verified bytes into an empty directory, then check the CLI. */
export function prepareNpmCli(archive, destination) {
  const bytes = verifiedBytes(archive);
  const staging = mkdtempSync(join(dirname(destination), ".verified-npm-"));
  try {
    const copy = join(staging, "npm.tgz");
    writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 });
    for (const name of ["user.npmrc", "global.npmrc"]) {
      writeFileSync(join(staging, name), "", { flag: "wx", mode: 0o600 });
    }
    const env = unprivilegedEnv(staging);
    const extracted = spawnSync(
      "/usr/bin/python3",
      ["-I", extractor, "tar", copy, destination],
      { encoding: "utf8", env },
    );
    if (extracted.status !== 0) {
      throw new Error("verified npm tarball could not be safely extracted");
    }
    const packageDir = join(destination, "package");
    const manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    if (manifest.name !== "npm" || manifest.version !== NPM_VERSION) {
      throw new Error("verified npm tarball has an unexpected identity");
    }
    const cli = join(packageDir, "bin", "npm-cli.js");
    const version = spawnSync(process.execPath, [cli, "--version"], {
      encoding: "utf8",
      env,
      cwd: destination,
    });
    if (version.status !== 0 || version.stdout.trim() !== NPM_VERSION) {
      throw new Error("verified npm CLI version check failed");
    }
    return cli;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    if (process.argv.length !== 4)
      throw new Error("expected tarball and destination");
    process.stdout.write(
      `${prepareNpmCli(process.argv[2], process.argv[3])}\n`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "npm preparation failed",
    );
    process.exitCode = 1;
  }
}
