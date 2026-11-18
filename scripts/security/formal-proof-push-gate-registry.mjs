import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isJsonObject, isString } from "../lib/json-boundary.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
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

function validSuite(suite, ids) {
  return (
    suite &&
    isString(suite.id) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suite.id) &&
    !ids.has(suite.id) &&
    validSuitePaths(suite) &&
    validLockProjection(suite) &&
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
