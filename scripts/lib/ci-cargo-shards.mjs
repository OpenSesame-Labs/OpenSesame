// Cargo shard planning for the trunk build: which workspace members one
// `cargo build` invocation compiles, and which members must share a shard.
// ci-affected-builds.mjs selects the plan; this module partitions it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parallel cargo jobs. Unset CARGO_SHARD keeps today's single invocation. */
export const CARGO_SHARD_COUNT = 4;

/**
 * Names today's cargo invocation would compile.
 * Scope `all` is every workspace member, which `cargo build --workspace` covers.
 */
function workspaceMemberDirs(root) {
  const text = readFileSync(join(root, "Cargo.toml"), "utf8");
  const block = text.split("members = [")[1]?.split("]")[0] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function packageName(manifest) {
  const sections = [...manifest.matchAll(/^\s*\[([^\n]+)\]\s*(?:#[^\n]*)?$/gm)];
  const packageSection = sections.find(
    (section) => section[1].trim() === "package",
  );
  if (!packageSection) return undefined;
  const body = manifest.slice(
    packageSection.index + packageSection[0].length,
    sections.find((section) => section.index > packageSection.index)?.index ??
      manifest.length,
  );
  return body.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
}

/** Every workspace member, including manifests whose name sits below a comment. */
export function loadWorkspaceMemberNames(root) {
  const names = [];
  for (const dir of workspaceMemberDirs(root)) {
    const file = join(root, dir, "Cargo.toml");
    if (!existsSync(file)) continue;
    const name = packageName(readFileSync(file, "utf8"));
    if (name) names.push(name);
  }
  return names;
}

export function cargoPlanMembers(plan, nodes, root) {
  if (plan.scope === "none") return [];
  if (plan.scope === "all") {
    return root
      ? loadWorkspaceMemberNames(root)
      : nodes.map((node) => node.name);
  }
  return [...plan.packages];
}

/**
 * Non-dev feature edges between workspace members.
 * Dev-dependencies do not affect `cargo build`, so they are not sticky.
 * @param {string} manifest
 * @param {Set<string>} members
 * @returns {[string, string][]}
 */
export function featurePairsInManifest(manifest, members) {
  const sections = [...manifest.matchAll(/^\s*\[([^\n]+)\]\s*(?:#[^\n]*)?$/gm)];
  const owner = packageName(manifest);
  if (!owner || !members.has(owner)) return [];
  const pairs = [];
  for (let index = 0; index < sections.length; index += 1) {
    const header = sections[index][1].trim();
    if (/(^|\.)dev-dependencies(?:\.|$)/.test(header)) continue;
    if (!/^(?:target\..+\.)?(?:build-)?dependencies(?:\.|$)/.test(header)) {
      continue;
    }
    const body = manifest.slice(
      sections[index].index + sections[index][0].length,
      sections[index + 1]?.index ?? manifest.length,
    );
    const dotted = header.match(
      /^(?:target\..+\.)?(?:build-)?dependencies\.(.+)$/,
    );
    const consider = (alias, spec) => {
      if (!/\bfeatures\s*=/.test(spec)) return;
      const renamed = spec.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? alias;
      if (renamed !== owner && members.has(renamed))
        pairs.push([owner, renamed]);
    };
    if (dotted) {
      consider(dotted[1].replaceAll(/["']/g, ""), body);
      continue;
    }
    for (const entry of body.matchAll(
      /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*\{([^}]*)\}/gm,
    )) {
      consider(entry[1], entry[2]);
    }
  }
  return pairs;
}

export function loadCargoFeaturePairs(root) {
  const members = new Set(loadWorkspaceMemberNames(root));
  const pairs = [];
  for (const dir of workspaceMemberDirs(root)) {
    const file = join(root, dir, "Cargo.toml");
    if (!existsSync(file)) continue;
    pairs.push(...featurePairsInManifest(readFileSync(file, "utf8"), members));
  }
  return pairs;
}

/**
 * Disjoint, stable partition. Sticky pairs share a shard so a workspace
 * feature edge stays in one cargo invocation. Round-robin assigns groups.
 * @param {string[]} names
 * @param {number} shardCount
 * @param {[string, string][]} stickyPairs
 * @returns {string[][]}
 */
export function partitionCargoMembers(names, shardCount, stickyPairs = []) {
  const count = Number(shardCount);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("cargo shard count must be a positive integer");
  }
  const unique = [...new Set(names)].sort();
  const parent = new Map(unique.map((name) => [name, name]));
  const find = (name) => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = name;
    while (cursor !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const [left, right] of stickyPairs) {
    if (!parent.has(left) || !parent.has(right)) continue;
    let rootLeft = find(left);
    let rootRight = find(right);
    if (rootLeft === rootRight) continue;
    if (rootLeft > rootRight) [rootLeft, rootRight] = [rootRight, rootLeft];
    parent.set(rootRight, rootLeft);
  }
  const groups = new Map();
  for (const name of unique) {
    const root = find(name);
    const list = groups.get(root) ?? [];
    list.push(name);
    groups.set(root, list);
  }
  const ordered = [...groups.values()]
    .map((group) => group.sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
  const shards = Array.from({ length: count }, () => []);
  for (const [index, group] of ordered.entries()) {
    shards[index % count].push(...group);
  }
  return shards.map((shard) => shard.sort());
}

/** Non-empty shard indexes. Shard 0 stays when the Bitwarden feature build must run. */
export function shardIndexesForPlan(plan, names, shardCount, stickyPairs) {
  const indexes = partitionCargoMembers(names, shardCount, stickyPairs)
    .map((packages, index) => (packages.length > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (plan.bitwarden === true && !indexes.includes(0)) indexes.unshift(0);
  return indexes;
}

/**
 * One shard of a cargo plan. An empty shard selects nothing so cargo is not
 * invoked (a bare `cargo build` would compile default-members only).
 */
export function applyCargoShard(
  plan,
  names,
  shard,
  shardCount,
  stickyPairs = [],
) {
  const index = Number(shard);
  const parts = partitionCargoMembers(names, shardCount, stickyPairs);
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) {
    throw new Error("cargo shard index is outside the partition");
  }
  const packages = parts[index];
  if (packages.length === 0) {
    return {
      scope: "none",
      packages: [],
      bitwarden: false,
      verifyExperience: false,
      verifyPackages: [],
      lintArtifacts: false,
    };
  }
  return {
    ...plan,
    scope: "packages",
    packages,
    bitwarden: plan.bitwarden === true && index === 0,
  };
}
