// Trunk compiles the affected dependency graph. Test selection and execution
// remain in ci-affected-tests.mjs for environment qualification.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fallbackPlan,
  loadCrateNodes,
  loadPackageNodes,
  planCrates,
  planPackages,
  repoRootFromHere,
} from "./ci-affected-graph.mjs";
import { readString } from "./json-boundary.mjs";

const PACKAGE_INPUTS = new Set([".npmrc", ".pnpmfile.cjs"]);

function normalizedPaths(paths) {
  return paths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""));
}

function isDocument(path) {
  return (
    path.endsWith(".md") || path === "LICENSE" || path.endsWith("/LICENSE")
  );
}

/** Shared inputs and a removed package manifest must not silently select none. */
export function planBuildPackages(paths, nodes) {
  const normalized = normalizedPaths(paths);
  const sharedInput = normalized.some((path) => {
    if (isDocument(path)) return false;
    if (PACKAGE_INPUTS.has(path)) return true;
    if (path.startsWith("patches/") || path.startsWith("spec/")) return true;
    if (!path.endsWith("/package.json")) return false;
    return !nodes.some((node) => path === `${node.dir}/package.json`);
  });
  return sharedInput
    ? fallbackPlan("packages")
    : planPackages(normalized, nodes);
}

/** Cargo compiles prerequisites itself; the graph selects all reverse dependents. */
export function planBuildCrates(paths, nodes) {
  // Linter configuration affects local linting, not compilation.
  const normalized = normalizedPaths(paths).filter(
    (path) => !["clippy.toml", "rustfmt.toml", "deny.toml"].includes(path),
  );
  return planCrates(normalized, nodes);
}

export function readBuildPlan(root, kind, base, head) {
  try {
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
      throw new Error("BASE_SHA and HEAD_SHA must be commit shas");
    }
    // --no-renames includes both sides of a move. NUL separation preserves
    // filenames with whitespace without inventing additional changed paths.
    const diff = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths = diff.split("\0").filter(Boolean);
    return kind === "cargo"
      ? planBuildCrates(paths, loadCrateNodes(root))
      : planBuildPackages(paths, loadPackageNodes(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `affected builds: ${message}; building the whole ${kind} graph`,
    );
    return fallbackPlan(kind);
  }
}

export function buildCommand(kind, plan, options = {}) {
  if (plan.scope === "none") return undefined;
  if (plan.scope === "packages" && plan.packages.length === 0) {
    throw new Error("affected build scope is packages but the list is empty");
  }
  const turboRef = text(options.turboComparisonRef);
  const comparisonFilter =
    turboRef.length > 0 ? `--filter=...[${turboRef}]` : undefined;
  const packageFilter = (name) =>
    turboRef.length > 0
      ? `--filter=${name}...[${turboRef}]`
      : `--filter=${name}`;
  if (kind === "cargo") {
    const args = ["build", "--locked"];
    if (plan.scope === "all") args.push("--workspace");
    else for (const name of plan.packages) args.push("-p", name);
    return { command: "cargo", args };
  }
  return {
    command: "npm",
    args: [
      "exec",
      "--",
      "turbo",
      "run",
      "build",
      "--concurrency=4",
      ...(plan.scope === "all"
        ? comparisonFilter
          ? [comparisonFilter]
          : []
        : plan.packages.map((name) => packageFilter(name))),
    ],
  };
}

function text(value) {
  return readString(value)?.trim() ?? "";
}

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

function emit(plan, extra = []) {
  const lines = [
    `scope=${plan.scope}`,
    `packages=${plan.packages.join(" ")}`,
    `selected=${plan.scope !== "none"}`,
    `bitwarden=${plan.bitwarden}`,
    ...extra,
  ];
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {
      flag: "a",
    });
  }
  for (const line of lines) console.log(line);
}

function main() {
  const command = process.argv[2] ?? "plan-ts";
  if (!["plan-ts", "plan-cargo", "run-ts", "run-cargo"].includes(command)) {
    console.error(
      "usage: ci-affected-builds.mjs plan-ts|plan-cargo|run-ts|run-cargo",
    );
    process.exit(2);
  }
  const kind = command.endsWith("cargo") ? "cargo" : "packages";
  const root = repoRootFromHere();
  const plan = readBuildPlan(
    root,
    kind,
    process.env.BASE_SHA ?? "",
    process.env.HEAD_SHA ?? "",
  );
  const shard = text(process.env.CARGO_SHARD);
  const shardCount = Number(process.env.CARGO_SHARD_COUNT || CARGO_SHARD_COUNT);
  if (command.startsWith("plan-")) {
    if (kind !== "cargo") return emit(plan);
    const nodes = loadCrateNodes(root);
    const pairs = loadCargoFeaturePairs(root);
    const indexes = shardIndexesForPlan(
      plan,
      cargoPlanMembers(plan, nodes, root),
      shardCount,
      pairs,
    );
    return emit(plan, [
      `shards=${JSON.stringify(indexes.length > 0 ? indexes : [0])}`,
    ]);
  }
  let effective = plan;
  if (kind === "cargo" && shard !== "") {
    const nodes = loadCrateNodes(root);
    effective = applyCargoShard(
      plan,
      cargoPlanMembers(plan, nodes, root),
      shard,
      shardCount,
      loadCargoFeaturePairs(root),
    );
  }
  const build = buildCommand(kind, effective, {
    turboComparisonRef: process.env.TURBO_COMPARISON_REF,
  });
  if (!build) {
    console.log(`no affected ${kind} build`);
    return;
  }
  const result = spawnSync(build.command, build.args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
