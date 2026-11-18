import { TextDecoder } from "node:util";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";
import { parseRegistry } from "./formal-proof-push-gate-registry.mjs";
import {
  assertPinnedRequirements,
  assertRequiredRegistry,
  parseRequirements,
  registryPath,
  requirementsPath,
  sameProofContract,
} from "./formal-proof-required-suites.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });

function readPolicyFile(root, revision, path, parse, git) {
  const entry = git(root, ["ls-tree", "-z", revision, "--", path]);
  if (!entry.length) return null;
  const text = decoder.decode(entry);
  const match =
    /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(
      text,
    );
  if (!match || match[3] !== path)
    throw new Error(
      `Formal proof policy ${path} in ${revision} is not a regular file`,
    );
  return parse(git(root, ["cat-file", "blob", match[2]]));
}

function policyCommits(root, change, git) {
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
    registryPath,
    requirementsPath,
  ]);
  const revisions = [
    ...new Set(decoder.decode(output).split("\n").filter(Boolean)),
  ];
  if (
    revisions.some(
      (revision) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision),
    )
  )
    throw new Error("Malformed formal proof policy history");
  return revisions;
}

function policyParents(root, revisions, git) {
  const parents = new Set();
  for (let offset = 0; offset < revisions.length; offset += 100) {
    const output = git(root, [
      "rev-list",
      "--parents",
      "--no-walk=unsorted",
      ...revisions.slice(offset, offset + 100),
    ]);
    for (const line of decoder.decode(output).split("\n").filter(Boolean)) {
      for (const parent of line.split(" ").slice(1)) parents.add(parent);
    }
  }
  return [...parents];
}

function validatePolicy(snapshot, revision) {
  if (!snapshot.requirements)
    throw new Error(
      `Formal proof requirements are missing from policy-changing commit ${revision}`,
    );
  if (!snapshot.registry)
    throw new Error(
      `Formal proof registry is missing from pushed commit ${revision}`,
    );
  assertRequiredRegistry(snapshot.registry, snapshot.requirements);
}

function validateIncomingPolicy(root, revision, snapshot, git) {
  if (snapshot.requirements) return validatePolicy(snapshot, revision);
  // A registry can precede the policy's first introduction. Its data remains
  // part of selection, but it cannot be compared to requirements that did not
  // yet exist. Once the manifest has appeared anywhere in the ancestry, its
  // removal is a policy error even if a later commit restores it.
  const prior = git(root, [
    "log",
    "-1",
    "--format=%H",
    "--no-patch",
    "--full-history",
    "--diff-merges=separate",
    revision,
    "--",
    requirementsPath,
  ]);
  if (prior.length)
    throw new Error(
      `Formal proof requirements are missing from policy-changing commit ${revision}`,
    );
}

export function inspectPolicyHistory(root, change, head, git) {
  const cache = new Map();
  const snapshot = (revision) => {
    if (!cache.has(revision))
      cache.set(revision, {
        registry: readPolicyFile(
          root,
          revision,
          registryPath,
          parseRegistry,
          git,
        ),
        requirements: readPolicyFile(
          root,
          revision,
          requirementsPath,
          parseRequirements,
          git,
        ),
      });
    return cache.get(revision);
  };
  const revisions = policyCommits(root, change, git);
  const parents = policyParents(root, revisions, git);
  const target = snapshot(change.target);
  const current = head && snapshot(head);
  const destination = change.destination && snapshot(change.destination);
  const main = change.policyBase && snapshot(change.policyBase);
  const changedPolicy =
    revisions.length > 0 ||
    change.changed.has(registryPath) ||
    change.changed.has(requirementsPath);
  if (changedPolicy) {
    // This also catches force pushes to an ancestor: there need not be an
    // incoming commit even though the destination policy changes.
    validatePolicy(target, change.target);
    assertPinnedRequirements(target.requirements);
    for (const revision of revisions)
      validateIncomingPolicy(root, revision, snapshot(revision), git);
  }
  return {
    target,
    snapshots: [
      target,
      current,
      destination,
      main,
      ...revisions.map(snapshot),
      ...parents.map(snapshot),
    ].filter(Boolean),
  };
}

function addMappings(mappings, suite, changed) {
  for (const path of suite.implementation) {
    if (!changed.has(path)) continue;
    if (!mappings.has(suite.id)) mappings.set(suite.id, new Set());
    mappings.get(suite.id).add(path);
  }
}

function collectMappings(snapshots, changed) {
  const mappings = new Map();
  for (const suite of PINNED_FORMAL_SUITES)
    addMappings(mappings, suite, changed);
  for (const snapshot of snapshots) {
    for (const policy of [snapshot.registry, snapshot.requirements]) {
      for (const suite of policy?.suites ?? [])
        addMappings(mappings, suite, changed);
    }
  }
  return mappings;
}

function assertRetainedMappings(suite, id, paths) {
  if (!suite)
    throw new Error(`Pushed commit removes required formal proof suite ${id}`);
  for (const path of paths) {
    if (!suite.implementation.includes(path))
      throw new Error(
        `Pushed commit removes required formal proof mapping ${id}: ${path}`,
      );
  }
}

function assertHistoricalContracts(suite, paths, snapshots) {
  for (const snapshot of snapshots) {
    for (const policy of [snapshot.registry, snapshot.requirements]) {
      const previous = policy?.suites.find((entry) => entry.id === suite.id);
      if (
        previous?.implementation.some((path) => paths.has(path)) &&
        !sameProofContract(previous, suite)
      )
        throw new Error(
          `Pushed history changes the formal proof contract for ${suite.id}`,
        );
    }
  }
}

export function selectHistoricalSuites(change, history) {
  const mappings = collectMappings(history.snapshots, change.changed);
  if (!mappings.size) return [];
  if (!history.target.registry)
    throw new Error(
      `Formal proof registry is missing from pushed commit ${change.target}`,
    );
  validatePolicy(history.target, change.target);
  assertPinnedRequirements(history.target.requirements);
  const suites = [];
  for (const [id, paths] of mappings) {
    const suite = history.target.registry.suites.find(
      (entry) => entry.id === id,
    );
    assertRetainedMappings(suite, id, paths);
    assertHistoricalContracts(suite, paths, history.snapshots);
    suites.push(suite);
  }
  return suites;
}
