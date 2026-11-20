import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isJsonObject } from "../lib/json-boundary.mjs";
import {
  manifestAncestors,
  manifestSetWriter,
  projectionArgs,
  projectionInputs,
  projectionKey,
} from "./formal-proof-manifest-set.mjs";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const helperPath = "scripts/security/cargo-lock-projection.py";
const manifestHelperPath = "scripts/security/cargo-workspace-projection.py";
const multiHelperPath = "scripts/security/cargo-workspace-multipackage.py";
const manifestSetPath = "scripts/security/formal-proof-manifest-set.mjs";

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

function trustedHelper(root, head, git, path = helperPath) {
  if (!head)
    throw new Error("Formal lock projection requires a committed HEAD");
  let current = root;
  const parts = path.split("/");
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
  const source = readFileSync(current);
  if (!source.equals(blob(root, head, path, git).data))
    throw new Error(
      "Formal lock projection helper differs from committed HEAD",
    );
  return source;
}

function candidates(history) {
  const suites = [...PINNED_FORMAL_SUITES];
  for (const snapshot of history.snapshots)
    for (const policy of [snapshot.registry, snapshot.requirements])
      suites.push(...(policy?.suites ?? []));
  return suites.filter(
    (suite) => suite.lockProjection || suite.manifestProjection,
  );
}

function revisionsAndParents(root, change, paths, git) {
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
    ...paths,
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

function comparator(root, helpers, dir, git) {
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
  const manifestSet = manifestSetWriter(root, dir, git, materialize);
  return (beforeRevision, afterRevision, descriptor, kind) => {
    const state = projectionInputs(
      readBlob,
      manifestSet,
      beforeRevision,
      afterRevision,
      descriptor,
      kind,
    );
    const key = projectionKey(descriptor, kind, state);
    if (comparisons.has(key)) return comparisons.get(key);
    const args = projectionArgs(helpers, descriptor, kind, state, materialize);
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

function descriptorChanged(
  root,
  change,
  descriptor,
  kind,
  histories,
  compare,
  git,
) {
  const inputs =
    kind === "manifest" && descriptor.manifests
      ? [
          descriptor.path,
          descriptor.lock,
          ...descriptor.manifests,
          ...manifestAncestors(descriptor.manifests),
        ]
      : [descriptor.path];
  const historyKey = JSON.stringify(inputs);
  if (!histories.has(historyKey))
    histories.set(historyKey, revisionsAndParents(root, change, inputs, git));
  let changed = false;
  if (change.destination)
    changed =
      compare(change.destination, change.target, descriptor, kind) || changed;
  for (const [revision, parents] of histories.get(historyKey)) {
    if (!parents.length)
      throw new Error(
        "Formal lock projection cannot compare a root commit without a parent",
      );
    const parentChanges = parents.map((parent) =>
      compare(parent, revision, descriptor, kind),
    );
    // A merge that inherits one parent's closure introduces no new resolution.
    if (parentChanges.every(Boolean)) changed = true;
  }
  return changed;
}

function descriptorTouches(kind, descriptor, changed) {
  if (!descriptor) return false;
  if (changed.has(descriptor.path)) return true;
  return (
    kind === "manifest" &&
    !!descriptor.manifests &&
    [
      descriptor.lock,
      ...descriptor.manifests,
      ...manifestAncestors(descriptor.manifests),
    ].some((path) => changed.has(path))
  );
}

function projectionHelpers(root, head, git, descriptors, dir) {
  const helpers = new Map();
  const copies = new Map();
  const verifiedCopy = (path) => {
    if (!copies.has(path)) {
      const source = trustedHelper(root, head, git, path);
      const target = join(dir, basename(path));
      writeFileSync(target, source, { mode: 0o600, flag: "wx" });
      copies.set(path, target);
    }
    return copies.get(path);
  };
  for (const { kind, descriptor } of descriptors) {
    if (!helpers.has(kind)) {
      // The manifest helper imports the shared lock graph parser.
      if (kind === "manifest") verifiedCopy(helperPath);
      helpers.set(
        kind,
        verifiedCopy(kind === "manifest" ? manifestHelperPath : helperPath),
      );
    }
    if (
      kind === "manifest" &&
      descriptor.manifests &&
      !helpers.has("multipackage")
    )
      helpers.set("multipackage", verifiedCopy(multiHelperPath));
  }
  return helpers;
}

export function lockAffectedSuites(root, change, history, head, git) {
  const suites = candidates(history);
  // This module supplies both projection inputs and registry path validation.
  // Check it before allowing its results to influence suite selection.
  if (suites.some((suite) => suite.manifestProjection?.manifests))
    trustedHelper(root, head, git, manifestSetPath);
  const descriptors = suites.flatMap((suite) =>
    [
      ["lock", suite.lockProjection],
      ["manifest", suite.manifestProjection],
    ]
      .filter(([kind, descriptor]) =>
        descriptorTouches(kind, descriptor, change.changed),
      )
      .map(([kind, descriptor]) => ({ id: suite.id, kind, descriptor })),
  );
  if (!descriptors.length) return new Set();
  const dir = mkdtempSync(join(tmpdir(), "formal-lock-"));
  try {
    const helpers = projectionHelpers(root, head, git, descriptors, dir);
    const compare = comparator(root, helpers, dir, git);
    const histories = new Map();
    const decisions = new Map();
    const affected = new Set();
    for (const { id, kind, descriptor } of descriptors) {
      const key = JSON.stringify([
        kind,
        descriptor.path,
        descriptor.root,
        descriptor.dependency ?? null,
        descriptor.package ?? null,
        descriptor.lock ?? null,
        descriptor.manifests ? [...descriptor.manifests].sort() : null,
      ]);
      if (!decisions.has(key))
        decisions.set(
          key,
          descriptorChanged(
            root,
            change,
            descriptor,
            kind,
            histories,
            compare,
            git,
          ),
        );
      if (decisions.get(key)) affected.add(id);
    }
    return affected;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
