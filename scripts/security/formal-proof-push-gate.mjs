#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { lockAffectedSuites } from "./formal-proof-lock-history.mjs";
import {
  assertCleanWorktree,
  assertProofFiles,
  hasControl,
  parseRegistry,
} from "./formal-proof-push-gate-registry.mjs";
import {
  inspectPolicyHistory,
  selectHistoricalSuites,
} from "./formal-proof-push-history.mjs";
import { pushDestination, remoteMain } from "./formal-proof-remote-main.mjs";
import {
  registryPath,
  requirementsPath,
} from "./formal-proof-required-suites.mjs";
import {
  assertProjectionRunnerHistory,
  assertRunnerHistory,
} from "./formal-proof-runner-history.mjs";
import {
  RUNNER_INVENTORY_PATH,
  validateRunnerInventoryHistory,
} from "./formal-proof-runner-pins.mjs";

export { assertProofFiles, parseRegistry };

const decoder = new TextDecoder("utf-8", { fatal: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const zero = (value) => /^0+$/u.test(value);
function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60000,
    });
  } catch {
    throw new Error(
      `Git could not determine pushed changes (${args[0]}). Fetch the remote and retry.`,
    );
  }
}

function commit(root, oid) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${oid}^{commit}`],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function hasObject(root, oid) {
  return (
    spawnSync("git", ["cat-file", "-e", `${oid}^{}`], {
      cwd: root,
      stdio: "ignore",
    }).status === 0
  );
}

function validRef(ref) {
  return (
    ref.startsWith("refs/") &&
    spawnSync("git", ["check-ref-format", ref], { stdio: "ignore" }).status ===
      0
  );
}

export function parsePushRefs(input) {
  let text;
  try {
    text = decoder.decode(input);
  } catch {
    throw new Error("Invalid UTF-8 in pre-push refs");
  }
  if (!text) return [];
  const seen = new Set();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((raw) => {
    const fields = raw.replace(/\r$/u, "").split(" ");
    if (
      fields.length !== 4 ||
      fields.some((v) => !v || hasControl(v)) ||
      !objectId.test(fields[1]) ||
      !objectId.test(fields[3]) ||
      fields[1].length !== fields[3].length ||
      !validRef(fields[2]) ||
      seen.has(fields[2]) ||
      (fields[0] === "(delete)") !== zero(fields[1]) ||
      (zero(fields[1]) && zero(fields[3]))
    )
      throw new Error("Malformed pre-push ref tuple");
    seen.add(fields[2]);
    return {
      localRef: fields[0],
      localOid: fields[1],
      remoteRef: fields[2],
      remoteOid: fields[3],
    };
  });
}

function pathSet(output) {
  let text;
  try {
    text = decoder.decode(output);
  } catch {
    throw new Error("Invalid UTF-8 in changed paths");
  }
  return new Set(text.split("\0").filter(Boolean));
}

function remoteTips(root, remote) {
  if (!remote || hasControl(remote))
    throw new Error("A remote is required to inspect a newly created ref");
  const advertised = decoder
    .decode(git(root, ["ls-remote", "--refs", "--", remote]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length !== 2 || !objectId.test(parts[0]) || !validRef(parts[1]))
        throw new Error("Malformed remote ref advertisement");
      return { oid: parts[0], ref: parts[1] };
    })
    .filter(
      ({ ref }) =>
        ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/"),
    );
  const unknown = advertised.filter(({ oid }) => !hasObject(root, oid));
  for (let offset = 0; offset < unknown.length; offset += 50) {
    const refs = unknown.slice(offset, offset + 50).map(({ ref }) => ref);
    git(root, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--filter=blob:none",
      "--",
      remote,
      ...refs,
    ]);
  }
  const tips = new Set();
  let main = null;
  for (const { oid, ref } of advertised) {
    if (!hasObject(root, oid))
      throw new Error("A remote ref changed while inspecting the push; retry.");
    const target = commit(root, oid);
    if (target) tips.add(target);
    if (ref === "refs/heads/main") {
      if (!target) throw new Error("The remote main ref is not a commit");
      main = target;
    }
  }
  if (
    unknown.length &&
    remoteMain(root, remote, { git, hasObject, commit }) !== main
  )
    throw new Error(
      "The remote main ref changed while inspecting the push; retry.",
    );
  return { tips: [...tips], main };
}

function nonCommitTag(root, remoteRef, oid) {
  if (!remoteRef.startsWith("refs/tags/")) return false;
  // A tag naming a tree or blob introduces no commit to verify.
  const peeled = decoder
    .decode(git(root, ["rev-parse", "--verify", `${oid}^{}`]))
    .trim();
  const type = decoder.decode(git(root, ["cat-file", "-t", peeled])).trim();
  return type === "blob" || type === "tree";
}

function changedForUpdate(root, ref, remote, getRemoteTips, getRemoteMain) {
  if (zero(ref.localOid)) return null;
  const target = commit(root, ref.localOid);
  if (!target) {
    if (nonCommitTag(root, ref.remoteRef, ref.localOid)) return null;
    throw new Error(
      `Pushed object for ${ref.remoteRef} is not a locally available commit`,
    );
  }
  let bases;
  let destination = null;
  let policyBase = null;
  let changed = new Set();
  if (zero(ref.remoteOid)) {
    const remoteState = getRemoteTips();
    bases = remoteState.tips;
    policyBase = remoteState.main;
  } else {
    let previous = commit(root, ref.remoteOid);
    if (!previous && !hasObject(root, ref.remoteOid)) {
      if (!remote)
        throw new Error(
          `Previous commit for ${ref.remoteRef} is unavailable and no remote was supplied`,
        );
      git(root, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--filter=blob:none",
        "--",
        remote,
        ref.remoteRef,
      ]);
      previous = commit(root, ref.remoteOid);
    }
    if (previous) {
      bases = [previous];
      destination = previous;
      changed = pathSet(
        git(root, [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          previous,
          target,
          "--",
        ]),
      );
    } else if (nonCommitTag(root, ref.remoteRef, ref.remoteOid)) {
      // A prior blob/tree tag has no commit history. As for a new ref, use
      // the remote's advertised commit tips to identify incoming commits.
      const remoteState = getRemoteTips();
      bases = remoteState.tips;
      policyBase = remoteState.main;
    } else {
      throw new Error(
        `Previous commit for ${ref.remoteRef} is unavailable; fetch and retry`,
      );
    }
  }
  const args = [
    "log",
    "--format=",
    "--name-only",
    "-z",
    "--root",
    "--diff-merges=combined",
    "--no-renames",
    target,
    ...bases.map((oid) => `^${oid}`),
    "--",
  ];
  for (const path of pathSet(git(root, args))) changed.add(path);
  return {
    target,
    changed,
    bases,
    destination,
    policyBase: policyBase ?? getRemoteMain(),
  };
}

export function planPush(root, refs, remote, exactDestination = false) {
  if (
    refs.some((ref) => !zero(ref.localOid)) &&
    decoder
      .decode(git(root, ["rev-parse", "--is-shallow-repository"]))
      .trim() === "true"
  )
    throw new Error(
      "A shallow checkout cannot establish all pushed changes. Fetch complete history and retry.",
    );
  let tips;
  let main;
  let checkedMain = false;
  const destination = refs.some((ref) => !zero(ref.localOid))
    ? pushDestination(root, remote, git, exactDestination)
    : remote;
  const getTips = () => {
    if (!tips) {
      tips = remoteTips(root, destination);
      main = tips.main;
      checkedMain = true;
    }
    return tips;
  };
  const getMain = () => {
    if (!checkedMain) {
      main = remoteMain(root, destination, { git, hasObject, commit });
      checkedMain = true;
    }
    return main;
  };
  const planned = new Map();
  const head = commit(root, "HEAD");
  for (const ref of refs) {
    const change = changedForUpdate(root, ref, destination, getTips, getMain);
    if (!change) continue;
    const history = inspectPolicyHistory(root, change, head, git);
    assertProjectionRunnerHistory(root, change, history, head, git);
    const lockAffected = lockAffectedSuites(root, change, history, head, git);
    const selected = selectHistoricalSuites(change, history, lockAffected);
    if (change.changed.has(RUNNER_INVENTORY_PATH))
      validateRunnerInventoryHistory(root, change, git);
    if (selected.length) assertRunnerHistory(root, change, selected, head, git);
    if (!selected.length) continue;
    const existing = planned.get(change.target) ?? new Map();
    for (const suite of selected) existing.set(suite.id, suite);
    planned.set(change.target, existing);
  }
  return [...planned].map(([target, suites]) => ({
    target,
    suites: [...suites.values()],
  }));
}

export function runPushGate(root, input, remote, exactDestination = false) {
  const plan = planPush(root, parsePushRefs(input), remote, exactDestination);
  if (!plan.length) {
    console.log("formal proof push gate: no mapped implementation changes");
    return;
  }
  const head = decoder
    .decode(git(root, ["rev-parse", "--verify", "HEAD^{commit}"]))
    .trim();
  if (plan.some(({ target }) => target !== head))
    throw new Error(
      "Mapped implementation changes include a non-HEAD commit or multiple pushed tips. Push each from a clean worktree checked out at its matching commit.",
    );
  assertCleanWorktree(
    root,
    git,
    "Mapped implementation changes require a clean worktree matching the pushed commit. Commit or isolate local changes and retry.",
  );
  for (const path of [registryPath, requirementsPath]) {
    const worktree = readFileSync(resolve(root, path));
    const pushed = git(root, ["show", `${head}:${path}`]);
    if (!worktree.equals(pushed))
      throw new Error(
        `Formal proof policy ${path} differs from the pushed commit`,
      );
  }
  for (const { suites } of plan) {
    for (const suite of suites) {
      assertProofFiles(root, suite);
      console.log(`formal proof push gate: checking ${suite.id} at ${head}`);
      const result = spawnSync(suite.command[0], suite.command.slice(1), {
        cwd: root,
        stdio: "inherit",
        env: process.env,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `Formal proof suite ${suite.id} failed or could not run`,
        );
      assertCleanWorktree(
        root,
        git,
        `Formal proof suite ${suite.id} changed the source tree. Restore a clean worktree and retry.`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const root = decoder
      .decode(git(process.cwd(), ["rev-parse", "--show-toplevel"]))
      .trim();
    runPushGate(
      root,
      readFileSync(0),
      process.argv[3] ?? process.argv[2],
      process.argv[3] !== undefined,
    );
  } catch (error) {
    console.error(`formal proof push gate: ${error.message}`);
    process.exitCode = 1;
  }
}
