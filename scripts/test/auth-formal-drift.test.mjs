import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as authC1 from "./auth-formal-snapshot-fixture.mjs";

const registryUrl = new URL(
  "../../spec/formal/proof-registry.json",
  import.meta.url,
);
const { implementation: paths } = JSON.parse(
  readFileSync(registryUrl),
).suites.find((suite) => suite.id === "auth");
const attestationPath = "spec/formal/auth/reviewed-sources.json";
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function configureIdentity(cwd) {
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
}
function commit(cwd, message, files = ["."], allowEmpty = false) {
  if (files.length) git(cwd, "add", ...files);
  const empty = allowEmpty ? ["--allow-empty"] : [];
  git(cwd, "-c", "commit.gpgsign=false", "commit", ...empty, "-qm", message);
}
function assertRejected(result, pattern) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}
function writeAttestation(cwd, path, sources) {
  writeFileSync(join(cwd, path), JSON.stringify({ version: 1, sources }));
}
function writeCoverage(cwd, reviewed_attestation, sources) {
  writeFileSync(
    join(cwd, "spec/formal/auth/coverage.json"),
    JSON.stringify({ version: 2, reviewed_attestation, sources }),
  );
}
function copyFixtureFile(root, path, source) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}
function buildReviewedStack(t) {
  const parent = mkdtempSync(join(tmpdir(), "auth-formal-drift-"));
  const root = join(parent, "source");
  const clone = join(parent, "fresh");
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const rootGit = (...args) => git(root, ...args);
  const check = (cwd = root) =>
    spawnSync(
      process.execPath,
      [join(cwd, "scripts/test/auth-formal-drift.mjs")],
      { cwd, encoding: "utf8" },
    );
  rootGit("init", "-q");
  rootGit("config", "user.name", "Test");
  rootGit("config", "user.email", "test@example.invalid");
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `original ${path}\n`);
  }
  authC1.seedAuthC1(root);
  copyFixtureFile(root, "spec/formal/proof-registry.json", registryUrl);
  copyFixtureFile(
    root,
    "scripts/test/auth-formal-drift.mjs",
    new URL("./auth-formal-drift.mjs", import.meta.url),
  );
  copyFixtureFile(
    root,
    "scripts/lib/json-boundary.mjs",
    new URL("../lib/json-boundary.mjs", import.meta.url),
  );
  rootGit("add", ".");
  rootGit("-c", "commit.gpgsign=false", "commit", "-qm", "original sources");
  const reviewedRevision = rootGit("rev-parse", "HEAD");
  const manifest = join(root, "spec/formal/auth/coverage.json");
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      reviewed_revision: reviewedRevision,
      sources: paths.map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      })),
    }),
  );
  assert.equal(check().status, 0);
  rootGit("add", "spec/formal/auth/coverage.json");
  rootGit(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "activate baseline review",
  );

  const reviewed = reviewedSources(root, "reviewed");
  const sources = reviewed.map(({ content: _content, ...entry }) => entry);
  writeAttestation(root, attestationPath, sources);
  commit(root, "review source bytes", [attestationPath]);
  for (const { content, path } of reviewed)
    writeFileSync(join(root, path), content);
  writeCoverage(root, attestationPath, sources);
  commit(root, "implement reviewed change");
  const full = check();
  assert.equal(full.status, 0, full.stderr);

  return { check, clone, parent, root, sources };
}
function verifyShallowClone({ check, clone, root, sources }) {
  git(root, "clone", "-q", "--depth=1", `file://${root}`, clone);
  const shallow = check(clone);
  assert.equal(shallow.status, 0, shallow.stderr);
  const clonedManifest = join(clone, "spec/formal/auth/coverage.json");
  const setSources = (nextSources) => {
    writeFileSync(
      clonedManifest,
      JSON.stringify({
        version: 2,
        reviewed_attestation: attestationPath,
        sources: nextSources,
      }),
    );
    return check(clone);
  };
  const wrong = setSources([
    { ...sources[0], reviewed_blob: "a".repeat(40) },
    ...sources.slice(1),
  ]);
  assertRejected(wrong, /manifest does not match reviewed-source attestation/);
  const restored = setSources(sources);
  assert.equal(restored.status, 0, restored.stderr);
  const clonedAttestation = join(clone, attestationPath);
  writeFileSync(
    clonedAttestation,
    JSON.stringify({
      version: 1,
      sources: [{ ...sources[0], sha256: "b".repeat(64) }, ...sources.slice(1)],
    }),
  );
  const attestationTamper = check(clone);
  assertRejected(
    attestationTamper,
    /manifest does not match reviewed-source attestation/,
  );
  writeFileSync(clonedAttestation, JSON.stringify({ version: 1, sources }));
  writeFileSync(join(clone, paths[0]), "worktree drift\n");
  const drift = check(clone);
  assertRejected(drift, /source drift/);
}

function rejectSameCommitAttestation({ check, parent, root }) {
  const self = join(parent, "self");
  git(root, "clone", "-q", `file://${root}`, self);
  configureIdentity(self);
  writeFileSync(join(self, paths[0]), "co-tampered\n");
  const coSources = JSON.parse(
    readFileSync(join(self, attestationPath), "utf8"),
  ).sources;
  const coBytes = readFileSync(join(self, paths[0]));
  coSources[0].reviewed_blob = execFileSync(
    "git",
    ["hash-object", "-w", paths[0]],
    { cwd: self, encoding: "utf8" },
  ).trim();
  coSources[0].sha256 = createHash("sha256").update(coBytes).digest("hex");
  writeFileSync(
    join(self, attestationPath),
    JSON.stringify({ version: 1, sources: coSources }),
  );
  writeFileSync(
    join(self, "spec/formal/auth/coverage.json"),
    JSON.stringify({
      version: 2,
      reviewed_attestation: attestationPath,
      sources: coSources,
    }),
  );
  commit(self, "self attest");
  const rejected = check(self);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /attestation must predate covered source changes/,
  );
}

function rejectPosthocAttestation({ check, parent, root }) {
  const posthoc = join(parent, "posthoc");
  git(root, "clone", "-q", `file://${root}`, posthoc);
  configureIdentity(posthoc);
  writeFileSync(join(posthoc, paths[0]), "changed before review\n");
  commit(posthoc, "source first", [paths[0]]);
  const posthocSources = JSON.parse(
    readFileSync(join(posthoc, attestationPath), "utf8"),
  ).sources;
  const posthocBlob = git(posthoc, "rev-parse", `HEAD:${paths[0]}`);
  const posthocBytes = readFileSync(join(posthoc, paths[0]));
  posthocSources[0] = {
    ...posthocSources[0],
    base_blob: posthocBlob,
    reviewed_blob: posthocBlob,
    sha256: createHash("sha256").update(posthocBytes).digest("hex"),
  };
  writeFileSync(
    join(posthoc, attestationPath),
    JSON.stringify({ version: 1, sources: posthocSources }),
  );
  commit(posthoc, "post-hoc attestation", [attestationPath]);
  writeFileSync(
    join(posthoc, "spec/formal/auth/coverage.json"),
    JSON.stringify({
      version: 2,
      reviewed_attestation: attestationPath,
      sources: posthocSources,
    }),
  );
  commit(posthoc, "activate post-hoc review", [
    "spec/formal/auth/coverage.json",
  ]);
  const posthocRejected = check(posthoc);
  assert.notEqual(posthocRejected.status, 0);
  assert.match(
    posthocRejected.stderr,
    /prior manifest did not validate source|attestation base is not the prior reviewed source/,
  );
}

function reviewedSources(cwd, prefix) {
  return paths.map((path) => {
    const content = `${prefix} ${path}\n`;
    const reviewed_blob = execFileSync(
      "git",
      ["hash-object", "-w", "--stdin"],
      {
        cwd,
        input: content,
        encoding: "utf8",
      },
    ).trim();
    return {
      base_blob: git(cwd, "rev-parse", `HEAD:${path}`),
      content,
      path,
      reviewed_blob,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function prepareSecondAttestation({ check, parent, root }) {
  const next = join(parent, "next");
  git(root, "clone", "-q", `file://${root}`, next);
  configureIdentity(next);
  const entries = reviewedSources(next, "second review");
  const sources = entries.map(({ content: _content, ...entry }) => entry);
  const nextAttestation = "spec/formal/auth/reviewed-sources-next.json";
  writeAttestation(next, nextAttestation, sources);
  commit(next, "prepare next review", [nextAttestation]);
  const pending = check(next);
  assert.equal(pending.status, 0, pending.stderr);
  for (const { content, path } of entries)
    writeFileSync(join(next, path), content);
  writeCoverage(next, nextAttestation, sources);
  commit(next, "activate next review");
  const activated = check(next);
  assert.equal(activated.status, 0, activated.stderr);
}

function rejectUnvalidatedParentManifest({ check, parent, root }) {
  const forged = join(parent, "forged-parent");
  git(root, "clone", "-q", `file://${root}`, forged);
  configureIdentity(forged);
  const entries = reviewedSources(forged, "forged");
  const sources = entries.map(({ content: _content, ...entry }) => entry);
  const forgedAttestation = "spec/formal/auth/reviewed-sources-forged.json";
  for (const { content, path } of entries)
    writeFileSync(join(forged, path), content);
  writeCoverage(forged, forgedAttestation, sources);
  commit(forged, "forge parent manifest");
  writeAttestation(forged, forgedAttestation, sources);
  commit(forged, "post-hoc evidence", [forgedAttestation]);
  commit(forged, "padding", [], true);
  const successorEntries = reviewedSources(forged, "successor");
  const successorSources = successorEntries.map(
    ({ content: _content, ...entry }) => entry,
  );
  const successorAttestation =
    "spec/formal/auth/reviewed-sources-successor.json";
  writeAttestation(forged, successorAttestation, successorSources);
  commit(forged, "prepare successor", [successorAttestation]);
  for (const { content, path } of successorEntries)
    writeFileSync(join(forged, path), content);
  writeCoverage(forged, successorAttestation, successorSources);
  commit(forged, "activate successor");
  const rejected = check(forged);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /prior reviewed-source attestation unavailable|prior attestation base lacks reviewed provenance/,
  );
}

function rejectAttestationMerge({ check, parent, root }) {
  const merged = join(parent, "merge-bypass");
  git(root, "clone", "-q", `file://${root}`, merged);
  configureIdentity(merged);
  const baseBranch = git(merged, "branch", "--show-current");
  git(merged, "switch", "-qc", "protected-change");
  const entries = reviewedSources(merged, "merged");
  for (const { content, path } of entries)
    writeFileSync(join(merged, path), content);
  commit(merged, "protected source");
  git(merged, "switch", "-q", baseBranch);
  git(merged, "merge", "--no-ff", "--no-commit", "protected-change");
  const sources = entries.map(({ content: _content, ...entry }) => entry);
  const mergeAttestation = "spec/formal/auth/reviewed-sources-merge.json";
  writeAttestation(merged, mergeAttestation, sources);
  commit(merged, "merge attestation", [mergeAttestation]);
  writeCoverage(merged, mergeAttestation, sources);
  commit(merged, "activate merge review", ["spec/formal/auth/coverage.json"]);
  const rejected = check(merged);
  assertRejected(rejected, /attestation must predate covered source changes/);
}

function rejectV1Downgrade({ check, parent, root }) {
  const downgrade = join(parent, "v1-downgrade");
  git(root, "clone", "-q", `file://${root}`, downgrade);
  configureIdentity(downgrade);
  const reviewed_revision = execFileSync(
    "git",
    ["rev-list", "--max-parents=0", "HEAD"],
    { cwd: downgrade, encoding: "utf8" },
  ).trim();
  const sources = paths.map((path) => {
    const content = execFileSync(
      "git",
      ["show", `${reviewed_revision}:${path}`],
      {
        cwd: downgrade,
      },
    );
    writeFileSync(join(downgrade, path), content);
    return { path, sha256: createHash("sha256").update(content).digest("hex") };
  });
  writeFileSync(
    join(downgrade, "spec/formal/auth/coverage.json"),
    JSON.stringify({ version: 1, reviewed_revision, sources }),
  );
  commit(downgrade, "downgrade evidence");
  const rejected = check(downgrade);
  assertRejected(rejected, /v2 reviewed-source evidence cannot downgrade/);

  const merged = join(parent, "v1-merge-downgrade");
  git(root, "clone", "-q", `file://${root}`, merged);
  configureIdentity(merged);
  const v2Side = git(merged, "rev-parse", "HEAD");
  git(merged, "switch", "-qc", "v1-first-parent", "HEAD^");
  git(merged, "merge", "--no-ff", "--no-commit", v2Side);
  git(
    merged,
    "restore",
    "--source=HEAD",
    "spec/formal/auth/coverage.json",
    ...paths,
  );
  commit(merged, "resolve merged evidence to v1");
  const mergeRejected = check(merged);
  assertRejected(mergeRejected, /v2 reviewed-source evidence cannot downgrade/);
}

test("a prior reviewed-source attestation survives squash and a shallow clone", (t) => {
  const fixture = buildReviewedStack(t);
  authC1.rejectAuthC1Drift(fixture.root, fixture.check);
  verifyShallowClone(fixture);
  rejectSameCommitAttestation(fixture);
  rejectPosthocAttestation(fixture);
  prepareSecondAttestation(fixture);
  rejectUnvalidatedParentManifest(fixture);
  rejectAttestationMerge(fixture);
  rejectV1Downgrade(fixture);
});
