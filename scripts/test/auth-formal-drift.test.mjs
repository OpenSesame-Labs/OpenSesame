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

const paths = [
  "packages/control-plane/src/middleware/auth.ts",
  "packages/control-plane/src/proofs/verified-principal.ts",
  "packages/control-plane/src/proofs/project-role.ts",
  "packages/control-plane/src/services/project-access.ts",
  "packages/os-domain/src/types.ts",
];
const attestationPath = "spec/formal/auth/reviewed-sources.json";

function configureIdentity(cwd) {
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd,
  });
}

function commit(cwd, message, files = ["."]) {
  execFileSync("git", ["add", ...files], { cwd });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-qm", message],
    { cwd },
  );
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

function buildReviewedStack(t) {
  const parent = mkdtempSync(join(tmpdir(), "auth-formal-drift-"));
  const root = join(parent, "source");
  const clone = join(parent, "fresh");
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const check = (cwd = root) =>
    spawnSync(
      process.execPath,
      [join(cwd, "scripts/test/auth-formal-drift.mjs")],
      { cwd, encoding: "utf8" },
    );
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `original ${path}\n`);
  }
  const script = join(root, "scripts/test/auth-formal-drift.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(
    script,
    readFileSync(new URL("./auth-formal-drift.mjs", import.meta.url)),
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "original sources");
  const reviewedRevision = git("rev-parse", "HEAD");
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
  git("add", "spec/formal/auth/coverage.json");
  git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "activate baseline review",
  );

  const reviewed = paths.map((path) => {
    const content = `reviewed ${path}\n`;
    const reviewed_blob = execFileSync(
      "git",
      ["hash-object", "-w", "--stdin"],
      { cwd: root, input: content, encoding: "utf8" },
    ).trim();
    return {
      base_blob: git("rev-parse", `${reviewedRevision}:${path}`),
      content,
      path,
      reviewed_blob,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const sources = reviewed.map(({ content: _content, ...entry }) => entry);
  writeFileSync(
    join(root, attestationPath),
    JSON.stringify({ version: 1, sources }),
  );
  git("add", attestationPath);
  git("-c", "commit.gpgsign=false", "commit", "-qm", "review source bytes");
  for (const { content, path } of reviewed)
    writeFileSync(join(root, path), content);
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 2,
      reviewed_attestation: attestationPath,
      sources,
    }),
  );
  git("add", ".");
  git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "implement reviewed change",
  );
  const full = check();
  assert.equal(full.status, 0, full.stderr);

  return { check, clone, parent, root, sources };
}

function verifyShallowClone({ check, clone, root, sources }) {
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${root}`, clone]);
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
  assert.notEqual(wrong.status, 0);
  assert.match(
    wrong.stderr,
    /manifest does not match reviewed-source attestation/,
  );
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
  assert.notEqual(attestationTamper.status, 0);
  assert.match(
    attestationTamper.stderr,
    /manifest does not match reviewed-source attestation/,
  );
  writeFileSync(clonedAttestation, JSON.stringify({ version: 1, sources }));
  writeFileSync(join(clone, paths[0]), "worktree drift\n");
  const drift = check(clone);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /source drift/);
}

function rejectSameCommitAttestation({ check, parent, root }) {
  const self = join(parent, "self");
  execFileSync("git", ["clone", "-q", `file://${root}`, self]);
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
  execFileSync("git", ["clone", "-q", `file://${root}`, posthoc]);
  configureIdentity(posthoc);
  writeFileSync(join(posthoc, paths[0]), "changed before review\n");
  commit(posthoc, "source first", [paths[0]]);
  const posthocSources = JSON.parse(
    readFileSync(join(posthoc, attestationPath), "utf8"),
  ).sources;
  const posthocBlob = execFileSync("git", ["rev-parse", `HEAD:${paths[0]}`], {
    cwd: posthoc,
    encoding: "utf8",
  }).trim();
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
      { cwd, input: content, encoding: "utf8" },
    ).trim();
    return {
      base_blob: execFileSync("git", ["rev-parse", `HEAD:${path}`], {
        cwd,
        encoding: "utf8",
      }).trim(),
      content,
      path,
      reviewed_blob,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function prepareSecondAttestation({ check, parent, root }) {
  const next = join(parent, "next");
  execFileSync("git", ["clone", "-q", `file://${root}`, next]);
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
  execFileSync("git", ["clone", "-q", `file://${root}`, forged]);
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
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "padding"],
    { cwd: forged },
  );
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
  execFileSync("git", ["clone", "-q", `file://${root}`, merged]);
  configureIdentity(merged);
  const baseBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd: merged,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["switch", "-qc", "protected-change"], { cwd: merged });
  const entries = reviewedSources(merged, "merged");
  for (const { content, path } of entries)
    writeFileSync(join(merged, path), content);
  commit(merged, "protected source");
  execFileSync("git", ["switch", "-q", baseBranch], { cwd: merged });
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "protected-change"], {
    cwd: merged,
  });
  const sources = entries.map(({ content: _content, ...entry }) => entry);
  const mergeAttestation = "spec/formal/auth/reviewed-sources-merge.json";
  writeAttestation(merged, mergeAttestation, sources);
  commit(merged, "merge attestation", [mergeAttestation]);
  writeCoverage(merged, mergeAttestation, sources);
  commit(merged, "activate merge review", ["spec/formal/auth/coverage.json"]);
  const rejected = check(merged);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /attestation must predate covered source changes/,
  );
}

test("a prior reviewed-source attestation survives squash and a shallow clone", (t) => {
  const fixture = buildReviewedStack(t);
  verifyShallowClone(fixture);
  rejectSameCommitAttestation(fixture);
  rejectPosthocAttestation(fixture);
  prepareSecondAttestation(fixture);
  rejectUnvalidatedParentManifest(fixture);
  rejectAttestationMerge(fixture);
});
