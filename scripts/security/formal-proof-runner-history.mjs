import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isJsonObject, isString } from "../lib/json-boundary.mjs";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";
import { loadRunnerInventory, runnerFor } from "./formal-proof-runner-pins.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const lockProjectionHelper = "scripts/security/cargo-lock-projection.py";
const manifestProjectionHelper =
  "scripts/security/cargo-workspace-projection.py";
const multiProjectionHelper =
  "scripts/security/cargo-workspace-multipackage.py";
const projectionSelector = "scripts/security/formal-proof-lock-history.mjs";
const manifestSetSelector = "scripts/security/formal-proof-manifest-set.mjs";
function readTree(root, revision, paths, git) {
  const raw = decoder.decode(
    git(root, ["ls-tree", "-z", revision, "--", ...paths]),
  );
  const entries = new Map();
  for (const record of raw.split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u.exec(
        record,
      );
    if (!match || !paths.includes(match[3]) || entries.has(match[3]))
      throw new Error(`Invalid formal runner tree at ${revision}`);
    entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  for (const path of paths)
    if (!entries.has(path))
      throw new Error(`Formal runner ${path} is missing at ${revision}`);
  return entries;
}

function optionalTree(root, revision, paths, kind, git) {
  if (!paths.length) return new Map();
  const raw = decoder.decode(
    git(root, ["ls-tree", "-z", revision, "--", ...paths]),
  );
  const entries = new Map();
  for (const record of raw.split("\0").filter(Boolean)) {
    const match =
      /^(040000 tree|100644 blob|100755 blob) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u.exec(
        record,
      );
    if (
      !match ||
      !paths.includes(match[3]) ||
      entries.has(match[3]) ||
      (kind === "directory"
        ? match[1] !== "040000 tree"
        : match[1] === "040000 tree")
    )
      throw new Error(`Invalid Cargo runner configuration at ${revision}`);
    entries.set(match[3], { mode: match[1].split(" ")[0], oid: match[2] });
  }
  return entries;
}

function cargoConfigs(root, revision, dirs, files, git) {
  optionalTree(root, revision, dirs, "directory", git);
  return optionalTree(root, revision, files, "file", git);
}

function npmScripts(root, entry, scripts, git) {
  let document;
  try {
    document = JSON.parse(
      decoder.decode(git(root, ["cat-file", "blob", entry.oid])),
    );
  } catch {
    throw new Error("Invalid package.json in formal runner history");
  }
  if (!isJsonObject(document) || !isJsonObject(document.scripts))
    throw new Error("Missing package scripts in formal runner history");
  const result = new Map();
  for (const script of scripts) {
    const values = [script, `pre${script}`, `post${script}`].map((name) => {
      const value = document.scripts[name];
      if (value === undefined && name !== script) return null;
      if (!isString(value) || !value.length)
        throw new Error(`Invalid npm formal runner ${name}`);
      return value;
    });
    result.set(script, JSON.stringify(values));
  }
  return result;
}

function historyRevisions(root, change, paths, git) {
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
  if (revisions.some((revision) => !objectId.test(revision)))
    throw new Error("Malformed formal runner history");
  const all = new Set([change.target, ...revisions]);
  for (let offset = 0; offset < revisions.length; offset += 100) {
    const output = git(root, [
      "rev-list",
      "--parents",
      "--no-walk=unsorted",
      ...revisions.slice(offset, offset + 100),
    ]);
    const seen = new Set();
    for (const line of decoder.decode(output).split("\n").filter(Boolean)) {
      const [revision, ...parents] = line.split(" ");
      if (
        ![revision, ...parents].every((oid) => objectId.test(oid)) ||
        seen.has(revision)
      )
        throw new Error("Malformed formal runner parent history");
      seen.add(revision);
      for (const parent of parents) all.add(parent);
    }
    if (seen.size !== revisions.slice(offset, offset + 100).length)
      throw new Error("Incomplete formal runner parent history");
  }
  return all;
}

function sameEntry(a, b) {
  return a.mode === b.mode && a.oid === b.oid;
}

function sameOptionalEntry(a, b) {
  if (!a || !b) return a === b;
  return sameEntry(a, b);
}

function isAncestor(root, ancestor, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, target],
    {
      cwd: root,
      stdio: "ignore",
      timeout: 60000,
    },
  );
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error("Cannot determine formal runner baseline ancestry");
  return result.status === 0;
}

function baselines(root, change, git) {
  if (change.destination) return [change.destination];
  const ancestors = [...new Set(change.bases)].filter((base) => {
    if (!objectId.test(base))
      throw new Error("Malformed formal runner baseline");
    return isAncestor(root, base, change.target);
  });
  if (!ancestors.length)
    throw new Error("Formal runner baseline is unavailable");
  const independent = decoder
    .decode(git(root, ["merge-base", "--independent", ...ancestors]))
    .split("\n")
    .filter(Boolean);
  if (!independent.length || independent.some((id) => !ancestors.includes(id)))
    throw new Error("Malformed formal runner baseline ancestry");
  return independent;
}

function compareSnapshot(
  baseline,
  current,
  runners,
  configFiles,
  optionalFiles,
  revision,
  shared,
) {
  for (const runner of runners) {
    if (
      baseline.scripts.get(runner.script) !== current.scripts.get(runner.script)
    )
      throw new Error(
        `Formal runner npm script ${runner.script} changed in pushed history at ${revision}; push runner changes separately`,
      );
    for (const path of [...shared, ...runner.files])
      if (!sameEntry(baseline.files.get(path), current.files.get(path)))
        throw new Error(
          `Formal runner ${path} changed in pushed history at ${revision}; push runner changes separately`,
        );
  }
  for (const path of configFiles)
    if (!sameOptionalEntry(baseline.cargo.get(path), current.cargo.get(path)))
      throw new Error(
        `Cargo runner configuration ${path} changed in pushed history at ${revision}; push runner changes separately`,
      );
  for (const path of optionalFiles)
    if (
      !sameOptionalEntry(
        baseline.optional.get(path),
        current.optional.get(path),
      )
    )
      throw new Error(
        `Formal runner metadata ${path} changed in pushed history at ${revision}; push runner changes separately`,
      );
}

function changedManifestInput(manifest, changed) {
  if (changed.has(manifest)) return true;
  const parents = manifest.split("/").slice(0, -1);
  for (let count = 1; count < parents.length; count++)
    if (changed.has(`${parents.slice(0, count).join("/")}/Cargo.toml`))
      return true;
  return false;
}

function changedManifestProjection(projection, changed) {
  if (changed.has(projection.path)) return true;
  if (!projection.manifests) return false;
  return (
    changed.has(projection.lock) ||
    projection.manifests.some((path) => changedManifestInput(path, changed))
  );
}

function requiredProjectionRunners(change, history) {
  const paths = new Set();
  const suites = [...PINNED_FORMAL_SUITES];
  for (const snapshot of history.snapshots)
    for (const policy of [snapshot.registry, snapshot.requirements])
      suites.push(...(policy?.suites ?? []));
  for (const suite of suites) {
    if (suite.lockProjection && change.changed.has(suite.lockProjection.path)) {
      paths.add(projectionSelector);
      paths.add(manifestSetSelector);
      paths.add(lockProjectionHelper);
    }
    if (
      suite.manifestProjection &&
      changedManifestProjection(suite.manifestProjection, change.changed)
    ) {
      paths.add(projectionSelector);
      paths.add(manifestSetSelector);
      paths.add(lockProjectionHelper);
      paths.add(manifestProjectionHelper);
      if (suite.manifestProjection.manifests) paths.add(multiProjectionHelper);
    }
  }
  return [...paths];
}

function matchesWorktree(root, path, expected, bytes) {
  let current = root;
  try {
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      current = resolve(current, segment);
      const stat = lstatSync(current);
      if (index < segments.length - 1) {
        if (!stat.isDirectory()) return false;
      } else {
        const mode = stat.mode & 0o111 ? "100755" : "100644";
        if (!stat.isFile() || (expected && mode !== expected.mode))
          return false;
      }
    }
    return Boolean(expected) && readFileSync(current).equals(bytes);
  } catch (error) {
    return !expected && error.code === "ENOENT";
  }
}

function assertProjectionWorktree(root, head, paths, git, optional = false) {
  if (!paths.length) return;
  const tree = optional
    ? optionalTree(root, head, paths, "file", git)
    : readTree(root, head, paths, git);
  for (const path of paths) {
    const expected = tree.get(path);
    const bytes = expected && git(root, ["cat-file", "blob", expected.oid]);
    if (!matchesWorktree(root, path, expected, bytes))
      throw new Error(
        `Formal ${optional ? "optional runner metadata" : "lock projection or workspace projection runner"} ${path} differs from committed HEAD or is not a regular file`,
      );
  }
}

export function assertProjectionRunnerHistory(
  root,
  change,
  history,
  head,
  git,
) {
  const projectionRunners = requiredProjectionRunners(change, history);
  if (!projectionRunners.length) return;
  if (!head)
    throw new Error(
      "Formal lock projection or workspace projection requires a committed HEAD",
    );
  assertProjectionWorktree(root, head, projectionRunners, git);
  const revisions = historyRevisions(root, change, projectionRunners, git);
  revisions.add(head);
  for (const base of baselines(root, change, git)) {
    const baseline = readTree(root, base, projectionRunners, git);
    for (const revision of revisions) {
      const current = readTree(root, revision, projectionRunners, git);
      for (const path of projectionRunners)
        if (!sameEntry(baseline.get(path), current.get(path)))
          throw new Error(
            `Formal lock projection or workspace projection runner ${path} changed in pushed history or HEAD at ${revision}; push runner changes separately`,
          );
    }
  }
}

export function assertRunnerHistory(root, change, suites, head, git) {
  if (!suites.length) return;
  const inventory = loadRunnerInventory(root, head, git);
  const runners = suites.map((suite) => runnerFor(suite, inventory));
  const paths = [
    ...new Set([
      "package.json",
      ...inventory.shared,
      ...runners.flatMap((runner) => runner.files),
    ]),
  ];
  const scripts = [...new Set(runners.map((runner) => runner.script))];
  const configDirs = [
    ...new Set(runners.flatMap((runner) => runner.cargoConfigDirs ?? [])),
  ];
  const configFiles = configDirs.flatMap((dir) => [
    `${dir}/config`,
    `${dir}/config.toml`,
  ]);
  const optionalFiles = [
    ...new Set(runners.flatMap((runner) => runner.optionalFiles ?? [])),
  ];
  if ((configFiles.length || optionalFiles.length) && !head)
    throw new Error("Formal execution metadata requires a committed HEAD");
  assertProjectionWorktree(
    root,
    head,
    [...configFiles, ...optionalFiles],
    git,
    true,
  );
  const state = (revision) => {
    const files = readTree(root, revision, paths, git);
    return {
      files,
      cargo: cargoConfigs(root, revision, configDirs, configFiles, git),
      optional: optionalTree(root, revision, optionalFiles, "file", git),
      scripts: npmScripts(root, files.get("package.json"), scripts, git),
    };
  };
  const revisions = historyRevisions(
    root,
    change,
    [...paths, ...configDirs, ...optionalFiles],
    git,
  );
  const snapshots = new Map();
  const getState = (revision) => {
    if (!snapshots.has(revision)) snapshots.set(revision, state(revision));
    return snapshots.get(revision);
  };
  for (const base of baselines(root, change, git)) {
    const baseline = getState(base);
    for (const revision of revisions)
      compareSnapshot(
        baseline,
        getState(revision),
        runners,
        configFiles,
        optionalFiles,
        revision,
        inventory.shared,
      );
  }
}
