import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isJsonObject, isString } from "../lib/json-boundary.mjs";
import {
  manifestAncestors,
  manifestBuildScripts,
} from "./formal-proof-manifest-set.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
export function assertCleanWorktree(root, git, dirtyMessage) {
  const entries = decoder.decode(git(root, ["ls-files", "-v", "-z"]));
  if (entries.split("\0").some((entry) => /^[a-zS] /u.test(entry)))
    throw new Error(
      "Mapped implementation changes require clearing assume-unchanged and skip-worktree index flags before proof verification",
    );
  if (
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      .length
  )
    throw new Error(dirtyMessage);
}
export const hasControl = (value) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

function safePath(path) {
  return (
    isString(path) &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !hasControl(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function validSuitePaths(suite) {
  return (
    Array.isArray(suite.implementation) &&
    suite.implementation.length > 0 &&
    suite.implementation.every(safePath) &&
    new Set(suite.implementation).size === suite.implementation.length &&
    Array.isArray(suite.proofs) &&
    suite.proofs.length > 0 &&
    suite.proofs.every(
      (path) => safePath(path) && path.startsWith("spec/formal/"),
    ) &&
    new Set(suite.proofs).size === suite.proofs.length
  );
}

function validSuiteCommand(command) {
  return (
    Array.isArray(command) &&
    command.length === 3 &&
    command[0] === "npm" &&
    command[1] === "run" &&
    isString(command[2]) &&
    /^verify:[a-z0-9][a-z0-9:-]*$/u.test(command[2])
  );
}

function validLockProjection(suite) {
  const projection = suite.lockProjection;
  if (projection === undefined) return true;
  if (!isJsonObject(projection)) return false;
  const keys = Object.keys(projection);
  const name = (value) =>
    isString(value) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
  return (
    keys.every((key) => ["path", "root", "dependency"].includes(key)) &&
    projection.path === "Cargo.lock" &&
    name(projection.root) &&
    (projection.dependency === undefined || name(projection.dependency)) &&
    !suite.implementation.includes(projection.path)
  );
}

function validManifestSet(suite, projection) {
  const manifests = projection.manifests;
  return (
    manifests === undefined ||
    (Array.isArray(manifests) &&
      manifests.length > 0 &&
      manifests.length <= 512 &&
      new Set(manifests).size === manifests.length &&
      manifests.includes(projection.package) &&
      manifests.every(
        (path) =>
          safePath(path) &&
          path.endsWith("/Cargo.toml") &&
          suite.implementation.includes(path),
      ) &&
      manifestAncestors(manifests).every((path) =>
        suite.implementation.includes(path),
      ) &&
      manifestBuildScripts(manifests).every((path) =>
        suite.implementation.includes(path),
      ) &&
      suite.lockProjection?.path === projection.lock &&
      suite.lockProjection?.root === projection.root &&
      suite.lockProjection?.dependency === undefined)
  );
}

function validManifestProjection(suite) {
  const projection = suite.manifestProjection;
  if (projection === undefined) return true;
  if (!isJsonObject(projection)) return false;
  return (
    Object.keys(projection).every((key) =>
      ["path", "package", "lock", "root", "manifests"].includes(key),
    ) &&
    projection.path === "Cargo.toml" &&
    projection.lock === "Cargo.lock" &&
    safePath(projection.package) &&
    projection.package.endsWith("/Cargo.toml") &&
    isString(projection.root) &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(projection.root) &&
    !suite.implementation.includes(projection.path) &&
    suite.implementation.includes(projection.package) &&
    validManifestSet(suite, projection)
  );
}

function validSuite(suite, ids) {
  return (
    suite &&
    isString(suite.id) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suite.id) &&
    !ids.has(suite.id) &&
    validSuitePaths(suite) &&
    validLockProjection(suite) &&
    validManifestProjection(suite) &&
    validSuiteCommand(suite.command)
  );
}

export function parseRegistry(bytes) {
  let registry;
  try {
    registry = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Invalid formal proof registry JSON");
  }
  if (
    registry?.version !== 1 ||
    !Array.isArray(registry.suites) ||
    !registry.suites.length
  )
    throw new Error("Invalid formal proof registry");
  const ids = new Set();
  for (const suite of registry.suites) {
    if (!validSuite(suite, ids))
      throw new Error(`Invalid formal proof suite: ${suite?.id ?? "unknown"}`);
    ids.add(suite.id);
  }
  return registry;
}

export function assertProofFiles(root, suite) {
  for (const proof of suite.proofs) {
    const segments = proof.split("/");
    let current = root;
    for (const [index, part] of segments.entries()) {
      current = resolve(current, part);
      let valid = false;
      try {
        const info = lstatSync(current);
        valid =
          index === segments.length - 1 ? info.isFile() : info.isDirectory();
      } catch {
        /* fail closed below */
      }
      if (!valid)
        throw new Error(
          `Formal proof ${proof} for ${suite.id} is missing or not a regular file`,
        );
    }
  }
}
