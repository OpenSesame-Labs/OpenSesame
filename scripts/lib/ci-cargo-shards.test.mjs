// Cargo shard planning, exercised through the names ci-affected-builds.mjs
// exports: the planner is the surface the trunk workflow and its callers use.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CARGO_SHARD_COUNT,
  applyCargoShard,
  buildCommand,
  cargoPlanMembers,
  featurePairsInManifest,
  loadCargoFeaturePairs,
  partitionCargoMembers,
  planBuildCrates,
  shardIndexesForPlan,
} from "./ci-affected-builds.mjs";
import { loadCrateNodes, repoRootFromHere } from "./ci-affected-graph.mjs";

test("cargo shards cover today's package set and keep feature edges together", () => {
  const sticky = [["lib", "app"]];
  const parts = partitionCargoMembers(
    ["app", "lib", "other", "solo"],
    CARGO_SHARD_COUNT,
    sticky,
  );
  assert.equal(parts.length, CARGO_SHARD_COUNT);
  assert.deepEqual(parts.flat().sort(), ["app", "lib", "other", "solo"]);
  const seen = new Set();
  for (const shard of parts) {
    for (const name of shard) {
      assert.equal(seen.has(name), false);
      seen.add(name);
    }
  }
  const appShard = parts.findIndex((shard) => shard.includes("app"));
  assert.equal(parts[appShard].includes("lib"), true);
  const all = { scope: "all", packages: [], bitwarden: true };
  const names = ["app", "lib", "other", "solo"];
  const indexes = shardIndexesForPlan(all, names, CARGO_SHARD_COUNT, sticky);
  assert.equal(indexes.includes(0), true);
  const built = [];
  for (const index of indexes) {
    const command = buildCommand(
      "cargo",
      applyCargoShard(all, names, index, CARGO_SHARD_COUNT, sticky),
    );
    if (!command) continue;
    assert.equal(command.args.includes("--workspace"), false);
    built.push(
      ...command.args.filter((arg, at) => command.args[at - 1] === "-p"),
    );
  }
  assert.deepEqual(built.sort(), names);
  assert.deepEqual(buildCommand("cargo", { scope: "all", packages: [] }), {
    command: "cargo",
    args: ["build", "--locked", "--workspace"],
  });
  assert.equal(
    applyCargoShard(all, names, 3, CARGO_SHARD_COUNT, sticky).scope,
    "none",
  );
  assert.equal(
    buildCommand(
      "cargo",
      applyCargoShard(all, names, 3, CARGO_SHARD_COUNT, sticky),
    ),
    undefined,
  );
});

test("dev-dependency features are not cargo-build edges", () => {
  const members = new Set(["app", "lib", "devlib"]);
  const pairs = featurePairsInManifest(
    [
      "# leading note so the name is not in the preamble",
      "[package]",
      'name = "app"',
      "[dependencies]",
      'lib = { path = "../lib", features = ["extra"] }',
      "[dev-dependencies]",
      'devlib = { path = "../devlib", features = ["only-dev"] }',
      "",
    ].join("\n"),
    members,
  );
  assert.deepEqual(pairs, [["app", "lib"]]);
});

test("the workspace partition builds every member exactly once", () => {
  const root = repoRootFromHere();
  const nodes = loadCrateNodes(root);
  const pairs = loadCargoFeaturePairs(root);
  const plan = planBuildCrates(["Cargo.toml"], nodes);
  assert.equal(plan.scope, "all");
  const names = cargoPlanMembers(plan, nodes, root);
  assert.ok(names.includes("opensesame-nats-callout"));
  assert.ok(names.length >= nodes.length);
  const parts = partitionCargoMembers(names, CARGO_SHARD_COUNT, pairs);
  assert.deepEqual(parts.flat().sort(), [...names].sort());
  const seen = new Set();
  for (const shard of parts) {
    for (const name of shard) {
      assert.equal(seen.has(name), false, name);
      seen.add(name);
    }
  }
  for (const [left, right] of pairs) {
    const leftShard = parts.findIndex((shard) => shard.includes(left));
    const rightShard = parts.findIndex((shard) => shard.includes(right));
    assert.equal(leftShard, rightShard, `${left} -> ${right}`);
  }
  const indexes = shardIndexesForPlan(plan, names, CARGO_SHARD_COUNT, pairs);
  const selected = new Set();
  for (const index of indexes) {
    const shardPlan = applyCargoShard(
      plan,
      names,
      index,
      CARGO_SHARD_COUNT,
      pairs,
    );
    const command = buildCommand("cargo", shardPlan);
    assert.notEqual(command, undefined);
    assert.equal(command.args.includes("--workspace"), false);
    for (let at = 0; at < command.args.length; at += 1) {
      if (command.args[at] === "-p") selected.add(command.args[at + 1]);
    }
  }
  assert.deepEqual([...selected].sort(), [...names].sort());
});
