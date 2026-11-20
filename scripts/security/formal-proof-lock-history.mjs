import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isJsonObject } from "../lib/json-boundary.mjs";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const helperPath = "scripts/security/cargo-lock-projection.py";

function blob(root, revision, path, git) {
  const entry = decoder.decode(
    git(root, ["ls-tree", "-z", revision, "--", path]),
  );
  const match =
    /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(
      entry,
    );
  if (!match || match[3] !== path)
    throw new Error(
      `Formal lock projection requires regular ${path} at ${revision}`,
    );
  return { oid: match[2], data: git(root, ["cat-file", "blob", match[2]]) };
}

function trustedHelper(root, head, git) {
  if (!head)
    throw new Error("Formal lock projection requires a committed HEAD");
  let current = root;
  const parts = helperPath.split("/");
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let valid = false;
    try {
      const stat = lstatSync(current);
      valid = index === parts.length - 1 ? stat.isFile() : stat.isDirectory();
    } catch {
      // Reject missing files and symlinks below.
    }
    if (!valid)
      throw new Error(
        "Formal lock projection helper is missing or not a regular file",
      );
  }
  if (!readFileSync(current).equals(blob(root, head, helperPath, git).data))
    throw new Error(
      "Formal lock projection helper differs from committed HEAD",
    );
  return current;
}

function candidates(history) {
  const suites = [...PINNED_FORMAL_SUITES];
  for (const snapshot of history.snapshots)
    for (const policy of [snapshot.registry, snapshot.requirements])
      suites.push(...(policy?.suites ?? []));
  return suites.filter((suite) => suite.lockProjection);
}

function revisionsAndParents(root, change, path, git) {
  const output = git(root, [
    "log",
    "--format=%H",
    "--no-patch",
    "--full-history",
    "--diff-merges=separate",
    "--root",
    change.target,
    ...change.bases.map((oid) => `^${oid}`),
    "--",
    path,
  ]);
  const revisions = [
    ...new Set(decoder.decode(output).split("\n").filter(Boolean)),
  ];
  if (revisions.some((revision) => !oidPattern.test(revision)))
    throw new Error("Malformed formal lock history");
  const result = new Map();
  for (let offset = 0; offset < revisions.length; offset += 100) {
    const lines = decoder
      .decode(
        git(root, [
          "rev-list",
          "--parents",
          "--no-walk=unsorted",
          ...revisions.slice(offset, offset + 100),
        ]),
      )
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const [revision, ...parents] = line.split(" ");
      if (
        ![revision, ...parents].every((oid) => oidPattern.test(oid)) ||
        result.has(revision)
      )
        throw new Error("Malformed formal lock parent history");
      result.set(revision, parents);
    }
  }
  if (
    result.size !== revisions.length ||
    revisions.some((revision) => !result.has(revision))
  )
    throw new Error("Incomplete formal lock parent history");
  return result;
}

function comparator(root, helper, dir, git) {
  const blobs = new Map();
  const paths = new Map();
  const comparisons = new Map();
  const readBlob = (revision, path) => {
    const key = `${revision}:${path}`;
    if (!blobs.has(key)) blobs.set(key, blob(root, revision, path, git));
    return blobs.get(key);
  };
  const materialize = ({ oid, data }) => {
    if (!paths.has(oid)) {
      const path = join(dir, oid);
      writeFileSync(path, data, { mode: 0o600, flag: "wx" });
      paths.set(oid, path);
    }
    return paths.get(oid);
  };
  return (beforeRevision, afterRevision, descriptor) => {
    const before = readBlob(beforeRevision, descriptor.path);
    const after = readBlob(afterRevision, descriptor.path);
    const key = JSON.stringify([
      before.oid,
      after.oid,
      descriptor.root,
      descriptor.dependency ?? null,
    ]);
    if (comparisons.has(key)) return comparisons.get(key);
    const args = ["-I", helper, "--allow-absent", "--root", descriptor.root];
    if (descriptor.dependency !== undefined)
      args.push("--dependency", descriptor.dependency);
    args.push(materialize(before), materialize(after));
    const result = spawnSync("python3", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.signal || result.status !== 0)
      throw new Error("Formal lock projection failed or could not run");
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      /* fail closed below */
    }
    if (
      !isJsonObject(value) ||
      Object.keys(value).length !== 1 ||
      (value.changed !== true && value.changed !== false)
    )
      throw new Error("Formal lock projection returned invalid output");
    comparisons.set(key, value.changed);
    return value.changed;
  };
}

function descriptorChanged(root, change, descriptor, histories, compare, git) {
  if (!histories.has(descriptor.path))
    histories.set(
      descriptor.path,
      revisionsAndParents(root, change, descriptor.path, git),
    );
  let changed = false;
  if (change.destination)
    changed = compare(change.destination, change.target, descriptor) || changed;
  for (const [revision, parents] of histories.get(descriptor.path)) {
    if (!parents.length)
      throw new Error(
        "Formal lock projection cannot compare a root commit without a parent",
      );
    const parentChanges = parents.map((parent) =>
      compare(parent, revision, descriptor),
    );
    // A merge that inherits one parent's closure introduces no new resolution.
    if (parentChanges.every(Boolean)) changed = true;
  }
  return changed;
}

export function lockAffectedSuites(root, change, history, head, git) {
  const suites = candidates(history).filter((suite) =>
    change.changed.has(suite.lockProjection.path),
  );
  if (!suites.length) return new Set();
  const helper = trustedHelper(root, head, git);
  const dir = mkdtempSync(join(tmpdir(), "formal-lock-"));
  try {
    const compare = comparator(root, helper, dir, git);
    const histories = new Map();
    const decisions = new Map();
    const affected = new Set();
    for (const suite of suites) {
      const descriptor = suite.lockProjection;
      const key = JSON.stringify([
        descriptor.path,
        descriptor.root,
        descriptor.dependency ?? null,
      ]);
      if (!decisions.has(key))
        decisions.set(
          key,
          descriptorChanged(root, change, descriptor, histories, compare, git),
        );
      if (decisions.get(key)) affected.add(suite.id);
    }
    return affected;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
