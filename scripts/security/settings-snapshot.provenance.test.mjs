import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parse } from "yaml";
import { ARTIFACTS, api, root } from "./settings-snapshot.fixtures.mjs";
import {
  ARTIFACT,
  FILE,
  MAX_ARCHIVE_BYTES,
  WORKFLOW,
  collect,
  extractRecord,
  previousArtifact,
  previousArtifacts,
  trustedRun,
  unreadable,
} from "./settings-snapshot.mjs";

const REPO = 1001;
const artifact = (id, branch, created, extra = {}) => ({
  id: id * 10,
  name: ARTIFACT,
  expired: false,
  created_at: created,
  archive_download_url: "https://elsewhere.example/zip",
  workflow_run: {
    id,
    head_branch: branch,
    repository_id: REPO,
    head_repository_id: REPO,
  },
  ...extra,
});
const run = (extra = {}) => ({
  path: WORKFLOW,
  head_branch: "main",
  event: "schedule",
  ...extra,
});

test("candidates are earlier records from this repository's own branch, newest first", () => {
  const fork = artifact(6, "main", "2026-11-10T12:00:00Z");
  fork.workflow_run.head_repository_id = 2002;
  const unknown = artifact(7, "main", "2026-11-10T13:00:00Z");
  unknown.workflow_run = { id: 7, head_branch: "main" };
  const artifacts = [
    fork,
    unknown,
    artifact(5, "main", "2026-11-10T00:00:00Z"),
    artifact(4, "main", "2026-11-03T00:00:00Z"),
    artifact(3, "other", "2026-11-09T00:00:00Z"),
    artifact(2, "main", "2026-11-08T00:00:00Z", { expired: true }),
    artifact(1, "main", "2026-11-09T00:00:00Z", { name: "something-else" }),
  ];
  const ids = (branch, runId) =>
    previousArtifacts(artifacts, { branch, runId }).map(
      (entry) => entry.workflow_run.id,
    );
  assert.deepEqual(ids("main", 9), [5, 4]);
  // The run never compares against its own upload.
  assert.deepEqual(ids("main", 5), [4]);
  assert.deepEqual(ids("other", 9), [3]);
  assert.deepEqual(ids("new-branch", 9), []);
});

test("only this workflow's scheduled run on the branch is trusted", () => {
  const at = { branch: "main" };
  assert.equal(trustedRun(run(), at), true);
  // A hand-started run could make a changed setting the next baseline, and
  // a tag named like the branch could supply a forged one.
  assert.equal(trustedRun(run({ event: "workflow_dispatch" }), at), false);
  assert.equal(trustedRun(run({ event: "pull_request" }), at), false);
  assert.equal(trustedRun(run({ event: "push" }), at), false);
  assert.equal(
    trustedRun(run({ path: ".github/workflows/ci.yml" }), at),
    false,
  );
  assert.equal(trustedRun(run({ head_branch: "other" }), at), false);
  assert.equal(trustedRun(undefined, at), false);
});

test("a record planted by another workflow is passed over for the last trusted one", async () => {
  const listed = {
    artifacts: [
      artifact(8, "main", "2026-11-10T00:00:00Z"),
      artifact(5, "main", "2026-11-03T00:00:00Z"),
    ],
  };
  const find = (runs) =>
    previousArtifact({
      repository: "o/r",
      token: "t",
      branch: "main",
      runId: 9,
      fetcher: api({ [ARTIFACTS]: listed, ...runs }),
    });
  const planted = await find({
    "/actions/runs/8": run({ path: ".github/workflows/ci.yml" }),
    "/actions/runs/5": run(),
  });
  assert.equal(planted.workflow_run.id, 5);
  const none = await find({
    "/actions/runs/8": run({ event: "pull_request" }),
    "/actions/runs/5": run({ event: "pull_request" }),
  });
  assert.equal(none, undefined);
  assert.equal((await find({ "/actions/runs/8": run() })).workflow_run.id, 8);
});

test("the token is sent to the GitHub API only", async () => {
  const fetcher = api();
  await collect({ repository: "o/r", token: "t", fetcher });
  assert.ok(fetcher.seen.length > 4);
  for (const { url, init } of fetcher.seen) {
    assert.equal(url.startsWith("https://api.github.com/repos/o/r"), true);
    assert.equal(init.headers.authorization, "Bearer t");
  }
  // The download address is built here, not taken from a response.
  const source = readFileSync(
    join(root, "scripts/security/settings-snapshot.mjs"),
    "utf8",
  );
  assert.equal(source.includes("archive_download_url"), false);
});

test("the workflow records first, then alarms, with a read-only token", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["repository-settings"];
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  // The runner context does not exist where job-level env is evaluated, and
  // the token is given only to the steps that call the API.
  assert.equal(job.env, undefined);
  const withToken = job.steps
    .filter((step) => step.env?.GH_TOKEN)
    .map((step) => step.run.match(/settings-snapshot\.mjs (\w+)/)[1]);
  assert.deepEqual(withToken, ["collect", "previous"]);
  const runs = job.steps.map((step) => String(step.run ?? step.uses));
  const at = (pattern) => runs.findIndex((text) => pattern.test(text));
  const collected = at(/settings-snapshot\.mjs collect/);
  const uploaded = at(/^actions\/upload-artifact@[a-f0-9]{40}$/);
  const compared = at(/settings-snapshot\.mjs compare/);
  assert.ok(collected >= 0 && uploaded > collected);
  // The new record is kept even when the comparison fails, so a change
  // raises one alarm and the next run starts from the new state.
  assert.ok(compared > uploaded);
  assert.equal(job.steps[uploaded].with.name, ARTIFACT);
  assert.equal(job.steps[uploaded].with["retention-days"], 90);
  assert.equal(job.steps[compared]["continue-on-error"], undefined);
  assert.equal(
    job.steps[compared].if,
    "steps.previous.outputs.found == 'true'",
  );
  // An unreadable section fails the run whether or not a change was found.
  const readable = at(/settings-snapshot\.mjs readable/);
  assert.ok(readable > uploaded);
  assert.equal(job.steps[readable].if, "${{ !cancelled() }}");
  assert.equal(job.steps[readable]["continue-on-error"], undefined);
  assert.equal(workflow.on.workflow_dispatch !== undefined, true);
  assert.equal(WORKFLOW, ".github/workflows/security.yml");
});

test("every section the token could not read is named, and only those", () => {
  const record = {
    repository: { visibility: "public" },
    default_branch_protected: true,
    rulesets: { unavailable: "HTTP 403" },
    environments: {
      Production: {
        reviewers: [],
        branches: { unavailable: "HTTP 404" },
      },
      Preview: { reviewers: [], branches: ["main"] },
    },
  };
  assert.deepEqual(unreadable(record), [
    { setting: "rulesets", reason: "HTTP 403" },
    {
      setting: "environments › Production › branches",
      reason: "HTTP 404",
    },
  ]);
  assert.deepEqual(unreadable({ unavailable: "HTTP 401" }), [
    { setting: "record", reason: "HTTP 401" },
  ]);
  assert.deepEqual(
    unreadable({ repository: { visibility: "public" }, rulesets: {} }),
    [],
  );
});

const work = mkdtempSync(join(tmpdir(), "opensesame-settings-archive-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** A zip archive of `entries`, built the way upload-artifact stores one. */
function archive(name, entries) {
  const source = join(work, `${name}-source`);
  mkdirSync(source);
  for (const [entry, make] of Object.entries(entries))
    make(join(source, entry));
  const zip = join(work, `${name}.zip`);
  // -y stores a link as a link instead of what it points at.
  execFileSync("zip", ["-q", "-y", zip, ...Object.keys(entries)], {
    cwd: source,
  });
  return readFileSync(zip);
}

test("only the record itself, as a regular file, is taken from the archive", () => {
  const record = '{"repository":{}}\n';
  const plain = join(work, "plain");
  const bytes = archive("plain", {
    [FILE]: (path) => writeFileSync(path, record),
    "other.json": (path) => writeFileSync(path, "{}"),
  });
  assert.equal(extractRecord(plain, bytes), true);
  assert.equal(readFileSync(join(plain, FILE), "utf8"), record);
  assert.throws(() => readFileSync(join(plain, "other.json")), /ENOENT/);

  const empty = archive("empty", {
    "other.json": (path) => writeFileSync(path, "{}"),
  });
  assert.equal(extractRecord(join(work, "empty"), empty), false);

  // A link in the record's place would be read through to wherever it points.
  const linked = archive("linked", {
    [FILE]: (path) => symlinkSync("/etc/hostname", path),
  });
  assert.throws(
    () => extractRecord(join(work, "linked"), linked),
    /not a regular file/,
  );

  assert.throws(
    () => extractRecord(join(work, "junk"), Buffer.from("not a zip archive")),
    /unreadable/,
  );
  assert.throws(
    () =>
      extractRecord(join(work, "large"), Buffer.alloc(MAX_ARCHIVE_BYTES + 1)),
    /too large/,
  );
});
