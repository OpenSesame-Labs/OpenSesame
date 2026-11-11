#!/usr/bin/env node
// Builds and verifies the patched dependency tarballs under patches/vendor/.
//
//   node scripts/security/patched-dependencies.mjs build    # rebuild tarballs, pin the lockfile
//   node scripts/security/patched-dependencies.mjs verify   # prove tarball == upstream + patch
//
// npm does not apply `patchedDependencies`. Each patch is therefore shipped as
// a tarball that is exactly the published package with the patch applied, and
// the lockfile pins that tarball by integrity, so a plain `npm ci` installs
// the patched code with no lifecycle script and no extra step.
//
// Both commands download the published package from the registry and refuse it
// unless it matches the upstream integrity recorded in the manifest.
// See patches/README.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST = "patches/vendor/manifest.json";

export function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/** npm's Subresource Integrity string for a file. */
export function integrity(file) {
  const digest = createHash("sha512").update(readFileSync(file));
  return `sha512-${digest.digest("base64")}`;
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A temporary directory may sit inside some other checkout. Git must treat
    // the extracted package as plain files, not as paths of that repository.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
}

/**
 * npm installs every entry of a tarball with its first path component
 * removed, whatever that component is called. A tarball is accepted only if
 * each entry is a regular file or directory below `package/`, so comparing
 * `package/` compares everything npm would install.
 */
export function assertPackageEntries(tarball) {
  const cwd = dirname(tarball);
  const names = run("tar", ["-tzf", tarball], cwd).split("\n").filter(Boolean);
  const types = run("tar", ["-tvzf", tarball], cwd)
    .split("\n")
    .filter(Boolean)
    .map((line) => line[0]);
  if (names.length === 0 || names.length !== types.length)
    throw new Error(`${tarball}: unreadable tarball listing`);
  for (const [index, name] of names.entries()) {
    const inside =
      name.startsWith("package/") && !name.split("/").includes("..");
    if (!inside || !["-", "d"].includes(types[index]))
      throw new Error(`${tarball}: refused entry ${JSON.stringify(name)}`);
  }
}

/** Unpacks an npm tarball into `into` and returns its `package/` directory. */
export function extract(tarball, into) {
  assertPackageEntries(tarball);
  mkdirSync(into, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", into], into);
  return join(into, "package");
}

/** Relative path to SHA-256 for every file below `directory`. */
export function fileMap(directory) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const digest = createHash("sha256").update(readFileSync(path));
        files[relative(directory, path)] = digest.digest("hex");
      }
    }
  };
  walk(directory);
  return files;
}

/** Whether `patch` applies to (`reverse` false) or is present in the tree. */
export function patchApplies(packageDirectory, patch, reverse) {
  const args = ["apply", "--check", "-p1", "--whitespace=nowarn"];
  if (reverse) args.push("-R");
  try {
    run("git", [...args, join(root, patch)], packageDirectory);
    return true;
  } catch {
    return false;
  }
}

/** Applies `patch` to the tree, or removes it when `reverse` is set. */
export function applyPatch(packageDirectory, patch, reverse = false) {
  const args = ["apply", "-p1", "--whitespace=nowarn"];
  if (reverse) args.push("-R");
  run("git", [...args, join(root, patch)], packageDirectory);
}

function lastLine(text) {
  return text.trim().split("\n").at(-1);
}

/**
 * Downloads the published package, checks it against the recorded upstream
 * integrity, applies the patch and packs the result with npm. No lifecycle
 * script of the package runs at any point.
 */
export function buildPatched(selector, entry, work) {
  const upstreamDirectory = join(work, "upstream");
  const output = join(work, "out");
  mkdirSync(upstreamDirectory, { recursive: true });
  mkdirSync(output, { recursive: true });
  const download = ["pack", selector, "--ignore-scripts", "--silent"];
  const upstream = join(
    upstreamDirectory,
    lastLine(
      run("npm", [...download, "--pack-destination", upstreamDirectory], work),
    ),
  );
  if (integrity(upstream) !== entry.upstreamIntegrity)
    throw new Error(
      `${selector}: the registry tarball does not match the recorded upstream integrity`,
    );
  const source = extract(upstream, join(work, "source"));
  applyPatch(source, entry.patch);
  const pack = ["pack", "--ignore-scripts", "--silent"];
  const packed = run("npm", [...pack, "--pack-destination", output], source);
  return join(output, lastLine(packed));
}

/** Files that differ between two file maps, in either direction. */
export function differingFiles(expected, actual) {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...paths].filter((path) => expected[path] !== actual[path]).sort();
}

/** Points every lockfile copy of `selector` at the tarball and its integrity. */
function pinLockfile(selector, tarball, value) {
  const at = selector.lastIndexOf("@");
  const name = selector.slice(0, at);
  const version = selector.slice(at + 1);
  const path = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(path, "utf8"));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.endsWith(`node_modules/${name}`) || entry.version !== version)
      continue;
    entry.resolved = `file:${tarball}`;
    entry.integrity = value;
  }
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function build(selector, entry, work) {
  const built = buildPatched(selector, entry, work);
  copyFileSync(built, join(root, entry.tarball));
  pinLockfile(selector, entry.tarball, integrity(built));
  console.log(`${selector}: wrote ${entry.tarball}`);
}

function verify(selector, entry, work) {
  const built = fileMap(extract(buildPatched(selector, entry, work), work));
  const committed = fileMap(
    extract(join(root, entry.tarball), join(work, "committed")),
  );
  const differing = differingFiles(built, committed);
  if (differing.length > 0)
    throw new Error(
      `${selector}: ${entry.tarball} is not the published package plus ${entry.patch}; differing: ${differing.join(", ")}`,
    );
  const count = Object.keys(committed).length;
  console.log(`${selector}: ${count} files equal upstream plus patch`);
}

function main(mode) {
  const action = { build, verify }[mode];
  if (!action) {
    console.error(
      "Usage: node scripts/security/patched-dependencies.mjs build|verify",
    );
    process.exit(2);
  }
  for (const [selector, entry] of Object.entries(readJson(MANIFEST).vendored)) {
    const work = mkdtempSync(join(tmpdir(), "opensesame-patched-"));
    try {
      action(selector, entry, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv[2]);
