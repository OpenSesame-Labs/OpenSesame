import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

const decoder = new TextDecoder("utf-8", { fatal: true });
const entryPattern =
  /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u;

export function manifestAncestors(manifests) {
  const ancestors = new Set();
  for (const path of manifests) {
    const parts = path.split("/").slice(0, -1);
    for (let count = 1; count < parts.length; count++)
      ancestors.add(`${parts.slice(0, count).join("/")}/Cargo.toml`);
  }
  return [...ancestors].sort();
}

export function manifestBuildScripts(manifests) {
  return manifests.map((path) => `${dirname(path)}/build.rs`);
}

function wantedPaths(manifests) {
  const ancestors = new Set(manifestAncestors(manifests));
  const files = new Set([...manifests, ...ancestors]);
  const parents = new Set();
  for (const path of manifests) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++)
      parents.add(parts.slice(0, count).join("/"));
  }
  return { files, parents, ancestors };
}

function treeEntries(root, revision, manifests, git) {
  const { files, parents, ancestors } = wantedPaths(manifests);
  const entries = new Map();
  // Include intermediate trees, so a symlink or submodule ancestor cannot
  // masquerade as an absent manifest even when it is outside this closure.
  const raw = decoder.decode(
    git(root, ["ls-tree", "-r", "-t", "-z", revision, "--"]),
  );
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = entryPattern.exec(record);
    if (!match) throw new Error("Malformed historical manifest tree");
    const [, mode, type, oid, path] = match;
    if (!files.has(path) && !parents.has(path)) continue;
    if (entries.has(path))
      throw new Error("Duplicate historical manifest path");
    if (ancestors.has(path))
      throw new Error(
        `Nested workspace manifest ${path} is unsupported at ${revision}`,
      );
    if (
      files.has(path) &&
      (type !== "blob" || !["100644", "100755"].includes(mode))
    )
      throw new Error(
        `Formal manifest ${path} is not a regular file at ${revision}`,
      );
    if (parents.has(path) && (type !== "tree" || mode !== "040000"))
      throw new Error(
        `Formal manifest parent ${path} is not a tree at ${revision}`,
      );
    entries.set(path, oid);
  }
  return entries;
}

export function manifestSetWriter(root, dir, git, materialize) {
  const cache = new Map();
  const files = new Set();
  return (revision, manifests) => {
    const key = JSON.stringify([revision, manifests]);
    if (cache.has(key)) return cache.get(key);
    const entries = treeEntries(root, revision, manifests, git);
    const snapshot = Object.fromEntries(
      [...new Set([...manifests, ...manifestAncestors(manifests)])].map(
        (path) => {
          const oid = entries.get(path);
          return [
            path,
            oid
              ? materialize({ oid, data: git(root, ["cat-file", "blob", oid]) })
              : null,
          ];
        },
      ),
    );
    const content = JSON.stringify(snapshot);
    const digest = createHash("sha256").update(content).digest("hex");
    const path = join(dir, `manifests-${digest}.json`);
    if (!files.has(path)) {
      writeFileSync(path, content, { mode: 0o600, flag: "wx" });
      files.add(path);
    }
    const value = { path, digest };
    cache.set(key, value);
    return value;
  };
}

export function projectionInputs(
  readBlob,
  manifestSet,
  before,
  after,
  descriptor,
  kind,
) {
  const left = readBlob(before, descriptor.path);
  const right = readBlob(after, descriptor.path);
  if (kind !== "manifest") return { inputs: [left, right] };
  if (descriptor.manifests !== undefined) {
    return {
      multi: true,
      beforeSet: manifestSet(before, descriptor.manifests),
      afterSet: manifestSet(after, descriptor.manifests),
      inputs: [
        left,
        readBlob(before, descriptor.lock),
        right,
        readBlob(after, descriptor.lock),
      ],
    };
  }
  return {
    inputs: [
      left,
      readBlob(before, descriptor.package),
      readBlob(before, descriptor.lock),
      right,
      readBlob(after, descriptor.package),
      readBlob(after, descriptor.lock),
    ],
  };
}

export function projectionKey(descriptor, kind, state) {
  return JSON.stringify([
    kind,
    ...state.inputs.map((input) => input.oid),
    descriptor.root,
    descriptor.dependency ?? null,
    descriptor.package ?? null,
    state.beforeSet?.digest ?? null,
    state.afterSet?.digest ?? null,
  ]);
}

export function projectionArgs(helpers, descriptor, kind, state, materialize) {
  const args = [
    "-I",
    helpers.get(state.multi ? "multipackage" : kind),
    "--root",
    descriptor.root,
  ];
  if (state.multi)
    args.push(
      "--root-manifest",
      descriptor.package,
      "--before-manifests",
      state.beforeSet.path,
      "--after-manifests",
      state.afterSet.path,
    );
  else if (kind === "manifest")
    args.push("--package-dir", dirname(descriptor.package));
  else {
    args.push("--allow-absent");
    if (descriptor.dependency !== undefined)
      args.push("--dependency", descriptor.dependency);
  }
  args.push(...state.inputs.map(materialize));
  return args;
}
