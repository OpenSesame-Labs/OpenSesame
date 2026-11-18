#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  assertProofFiles,
  hasControl,
  parseRegistry,
} from "./formal-proof-push-gate-registry.mjs";

export { assertProofFiles, parseRegistry };

const registryPath = "spec/formal/proof-registry.json";
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
  for (const { oid } of advertised) {
    if (!hasObject(root, oid))
      throw new Error("A remote ref changed while inspecting the push; retry.");
    const target = commit(root, oid);
    if (target) tips.add(target);
  }
  return [...tips];
}

function nonCommitTag(root, remoteRef, oid) {
  if (!remoteRef.startsWith("refs/tags/")) return false;
  // Tags can name trees or blobs, directly or through annotated tags. They do
  // not introduce a commit whose implementation needs proof verification.
  const peeled = decoder
    .decode(git(root, ["rev-parse", "--verify", `${oid}^{}`]))
    .trim();
  const type = decoder.decode(git(root, ["cat-file", "-t", peeled])).trim();
  return type === "blob" || type === "tree";
}

function changedForUpdate(root, ref, remote, getRemoteTips) {
  if (zero(ref.localOid)) return null;
  const target = commit(root, ref.localOid);
  if (!target) {
    if (nonCommitTag(root, ref.remoteRef, ref.localOid)) return null;
    throw new Error(
      `Pushed object for ${ref.remoteRef} is not a locally available commit`,
    );
  }
  let bases;
  let changed = new Set();
  if (zero(ref.remoteOid)) {
    bases = getRemoteTips();
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
      bases = getRemoteTips();
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
  return { target, changed, bases };
}

function registryAt(root, revision, required = false) {
  const entry = git(root, ["ls-tree", "-z", revision, "--", registryPath]);
  if (!entry.length) {
    if (required)
      throw new Error(
        `Formal proof registry is missing from pushed commit ${revision}`,
      );
    return null;
  }
  if (!/^100(?:644|755) blob [a-f0-9]+\t/u.test(decoder.decode(entry)))
    throw new Error(
      `Formal proof registry in ${revision} is not a regular file`,
    );
  return parseRegistry(git(root, ["show", `${revision}:${registryPath}`]));
}

export function planPush(root, refs, remote) {
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
  const getTips = () => (tips ??= remoteTips(root, remote));
  const planned = new Map();
  const cache = new Map();
  const getRegistry = (revision, required = false) => {
    if (!cache.has(revision))
      cache.set(revision, registryAt(root, revision, required));
    const registry = cache.get(revision);
    if (!registry && required)
      throw new Error(
        `Formal proof registry is missing from pushed commit ${revision}`,
      );
    return registry;
  };
  const head = commit(root, "HEAD");
  const currentRegistry = head && getRegistry(head);
  for (const ref of refs) {
    const change = changedForUpdate(root, ref, remote, getTips);
    if (!change) continue;
    const targetRegistry = getRegistry(change.target);
    // Previous mappings remain binding on a change that removes or moves a
    // registry entry. The committed registries, never dirty files, select.
    const registries = [
      targetRegistry,
      currentRegistry,
      ...change.bases.map((base) => getRegistry(base)),
    ].filter(Boolean);
    const ids = new Set();
    for (const registry of registries) {
      for (const suite of registry.suites) {
        if (suite.implementation.some((path) => change.changed.has(path)))
          ids.add(suite.id);
      }
    }
    if (!ids.size) continue;
    const selectedRegistry = getRegistry(change.target, true);
    const selected = [];
    for (const id of ids) {
      const suite = selectedRegistry.suites.find((entry) => entry.id === id);
      if (!suite)
        throw new Error(
          `Pushed commit removes required formal proof suite ${id}; restore the reviewed registry entry`,
        );
      selected.push(suite);
    }
    const existing = planned.get(change.target) ?? new Map();
    for (const suite of selected) existing.set(suite.id, suite);
    planned.set(change.target, existing);
  }
  return [...planned].map(([target, suites]) => ({
    target,
    suites: [...suites.values()],
  }));
}

export function runPushGate(root, input, remote) {
  const plan = planPush(root, parsePushRefs(input), remote);
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
  if (
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      .length
  )
    throw new Error(
      "Mapped implementation changes require a clean worktree matching the pushed commit. Commit or isolate local changes and retry.",
    );
  const registryBytes = readFileSync(resolve(root, registryPath));
  const pushedRegistry = git(root, ["show", `${head}:${registryPath}`]);
  if (!registryBytes.equals(pushedRegistry))
    throw new Error("The formal proof registry differs from the pushed commit");
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
      if (
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
          .length
      )
        throw new Error(
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
    runPushGate(root, readFileSync(0), process.argv[2]);
  } catch (error) {
    console.error(`formal proof push gate: ${error.message}`);
    process.exitCode = 1;
  }
}
