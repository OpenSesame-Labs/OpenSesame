import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_WORKFLOW_PATH,
  REQUIRED_CHECK_NAMES,
  classifyRuns,
  failedChecks,
  readGateConfig,
  resolveAdmittedMainCiRun,
  waitForMainCi,
} from "./cd-main-ci-gate.mjs";

const sha = "a".repeat(40);
const repository = "OpenSesame-Labs/OpenSesame";

function run(extra = {}) {
  return {
    id: 10,
    path: CI_WORKFLOW_PATH,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_repository: { full_name: repository },
    ...extra,
  };
}

function succeededJobs() {
  return REQUIRED_CHECK_NAMES.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function config(extra = {}) {
  return {
    token: "test-token",
    repository,
    sha,
    attempts: 2,
    intervalMs: 0,
    ...extra,
  };
}

test("required check names stay the merge-queue contexts", () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, [
    "TypeScript",
    "Rust",
    "Bundle budgets",
  ]);
});

test("gate config reads GH_TOKEN and rejects a short sha", () => {
  const parsed = readGateConfig({
    GH_TOKEN: "token",
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: sha,
    CI_GATE_ATTEMPTS: "3",
    CI_GATE_INTERVAL_MS: "0",
  });
  assert.equal(parsed.token, "token");
  assert.equal(parsed.attempts, 3);
  assert.equal(parsed.intervalMs, 0);
  assert.throws(
    () =>
      readGateConfig({
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: sha,
      }),
    /GH_TOKEN or GITHUB_TOKEN is required/,
  );
  assert.throws(
    () =>
      readGateConfig({
        GITHUB_TOKEN: "token",
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: "abc",
      }),
    /40 lowercase hex/,
  );
});

test("classifyRuns keeps a completed successful main push for this sha", () => {
  const classified = classifyRuns(
    [
      run({ id: 1, event: "workflow_dispatch" }),
      run({ id: 2, head_branch: "feature" }),
      run({ id: 3, head_sha: "b".repeat(40) }),
      run({ id: 4, conclusion: "failure" }),
      run({ id: 5, status: "in_progress", conclusion: null }),
      run({ id: 6, head_repository: { full_name: "other/repo" } }),
      run({ id: 7 }),
    ],
    sha,
    repository,
  );
  assert.deepEqual(
    classified.successful.map((entry) => entry.id),
    [7],
  );
  assert.equal(classified.completedFailure, true);
  assert.equal(classified.pending, true);
});

test("failedChecks requires every required job to succeed", () => {
  assert.deepEqual(failedChecks(succeededJobs()), []);
  assert.match(
    failedChecks(succeededJobs().filter((job) => job.name !== "Rust")).join(
      " ",
    ),
    /Rust missing/,
  );
  const skipped = succeededJobs().map((job) =>
    job.name === "Bundle budgets" ? { ...job, conclusion: "skipped" } : job,
  );
  assert.match(
    failedChecks(skipped).join(" "),
    /Bundle budgets completed\/skipped/,
  );
});

test("waitForMainCi admits the sha after the push run succeeds", async () => {
  let lists = 0;
  const fetcher = async (url) => {
    if (String(url).includes("/jobs"))
      return jsonResponse({ jobs: succeededJobs() });
    lists += 1;
    if (lists === 1) {
      return jsonResponse({
        workflow_runs: [run({ status: "in_progress", conclusion: null })],
      });
    }
    return jsonResponse({ workflow_runs: [run({ id: 42 })] });
  };
  let slept = 0;
  const admitted = await waitForMainCi(config(), fetcher, async () => {
    slept += 1;
  });
  assert.deepEqual(admitted, { runId: "42", sha });
  assert.equal(slept, 1);
});

test("waitForMainCi fails closed when the main push completed unsuccessfully", async () => {
  let slept = 0;
  const fetcher = async () =>
    jsonResponse({
      workflow_runs: [run({ conclusion: "failure" })],
    });
  await assert.rejects(
    () =>
      waitForMainCi(config(), fetcher, async () => {
        slept += 1;
      }),
    /completed without success/,
  );
  assert.equal(slept, 0);
});

test("waitForMainCi rejects a successful run whose required check failed", async () => {
  const fetcher = async (url) => {
    if (String(url).includes("/jobs")) {
      return jsonResponse({
        jobs: succeededJobs().map((job) =>
          job.name === "TypeScript" ? { ...job, conclusion: "failure" } : job,
        ),
      });
    }
    return jsonResponse({ workflow_runs: [run()] });
  };
  await assert.rejects(
    () => waitForMainCi(config({ attempts: 3 }), fetcher, async () => {}),
    /TypeScript completed\/failure/,
  );
});

test("waitForMainCi keeps polling when no ci.yml run exists yet", async () => {
  let lists = 0;
  const fetcher = async () => {
    lists += 1;
    return jsonResponse({ workflow_runs: [] });
  };
  await assert.rejects(
    () => waitForMainCi(config({ attempts: 2 }), fetcher, async () => {}),
    /did not succeed/,
  );
  assert.equal(lists, 2);
});

test("resolveAdmittedMainCiRun returns the admitted run id in one pass", async () => {
  const fetcher = async (url) => {
    if (String(url).includes("/jobs"))
      return jsonResponse({ jobs: succeededJobs() });
    return jsonResponse({ workflow_runs: [run({ id: 99 })] });
  };
  const admitted = await resolveAdmittedMainCiRun(config(), fetcher);
  assert.deepEqual(admitted, { runId: "99", sha });
});
