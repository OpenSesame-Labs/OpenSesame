import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  ARTIFACT,
  changes,
  collect,
  declaredDifferences,
  previousArtifact,
  renderChanges,
  stable,
} from "./settings-snapshot.mjs";

const script = fileURLToPath(
  new URL("./settings-snapshot.mjs", import.meta.url),
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "opensesame-settings-"));
after(() => rmSync(work, { recursive: true, force: true }));
const declared = (name) =>
  JSON.parse(readFileSync(join(root, "ops/github", name), "utf8"));
const branchPolicy = declared("default-branch.json");

/** A fake API for one repository; a path mapped to a number answers that status. */
function api(overrides = {}) {
  const base = "https://api.github.com/repos/o/r";
  const routes = {
    "": {
      visibility: "public",
      private: false,
      archived: false,
      disabled: false,
      default_branch: "main",
      fork: false,
      allow_forking: true,
      web_commit_signoff_required: false,
      pushed_at: "2026-11-11T00:00:00Z",
      stargazers_count: 7,
    },
    "/branches/main": { name: "main", protected: true },
    "/rulesets?per_page=100&includes_parents=true": [
      { id: 1, name: branchPolicy.name },
    ],
    "/rulesets/1": {
      ...branchPolicy,
      id: 1,
      updated_at: "2026-11-01T00:00:00Z",
    },
    "/environments?per_page=100": {
      environments: [
        {
          name: "release",
          updated_at: "2026-11-01T00:00:00Z",
          protection_rules: [
            {
              type: "required_reviewers",
              prevent_self_review: false,
              reviewers: [{ type: "User", reviewer: { id: 145080887 } }],
            },
          ],
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
      ],
    },
    "/environments/release/deployment-branch-policies?per_page=100": {
      branch_policies: [{ name: "main", type: "branch" }],
    },
    ...overrides,
  };
  return async (url) => {
    const value = routes[url.slice(base.length)];
    if (Number.isInteger(value) || value === undefined)
      return { ok: false, status: value ?? 404 };
    return { ok: true, json: async () => value };
  };
}

const snapshot = (overrides) =>
  collect({ repository: "o/r", token: "t", fetcher: api(overrides) });

test("the record holds settings, not activity, in a fixed order", async () => {
  const record = await snapshot();
  assert.deepEqual(Object.keys(record), [
    "default_branch_protected",
    "environments",
    "repository",
    "rulesets",
  ]);
  assert.equal(record.default_branch_protected, true);
  // Counters and timestamps would make every run look like a change.
  assert.equal(JSON.stringify(record).includes("pushed_at"), false);
  assert.equal(JSON.stringify(record).includes("updated_at"), false);
  assert.equal(JSON.stringify(record).includes("stargazers"), false);
  assert.deepEqual(record.environments.release, {
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
    deployment_branches: ["branch:main"],
    protection_rules: [
      {
        prevent_self_review: false,
        reviewers: ["User:145080887"],
        type: "required_reviewers",
        wait_timer: null,
      },
    ],
  });
  assert.deepEqual(await snapshot(), record);
  assert.deepEqual(changes(record, await snapshot()), []);
});

test("a bypass list the token is not shown is recorded as not visible", async () => {
  const { bypass_actors: _hidden, ...withoutBypass } = branchPolicy;
  const record = await snapshot({ "/rulesets/1": withoutBypass });
  assert.equal(
    record.rulesets[branchPolicy.name].bypass_actors,
    "not visible to this token",
  );
});

test("the changes that matter are each reported with both values", async () => {
  const before = await snapshot();
  const cases = [
    [
      { "/rulesets/1": { ...branchPolicy, enforcement: "disabled" } },
      `rulesets › ${branchPolicy.name} › enforcement`,
    ],
    [
      { "/rulesets?per_page=100&includes_parents=true": [] },
      `rulesets › ${branchPolicy.name}`,
    ],
    [
      { "": { visibility: "private", private: true, default_branch: "main" } },
      "repository › visibility",
    ],
    [{ "/branches/main": { protected: false } }, "default_branch_protected"],
    [
      { "/environments?per_page=100": { environments: [] } },
      "environments › release",
    ],
    [
      {
        "/environments/release/deployment-branch-policies?per_page=100": {
          branch_policies: [
            { name: "main", type: "branch" },
            { name: "v*", type: "tag" },
          ],
        },
      },
      "environments › release › deployment_branches",
    ],
  ];
  for (const [overrides, setting] of cases) {
    const found = changes(before, await snapshot(overrides));
    assert.ok(
      found.some((entry) => entry.setting === setting),
      `${setting} not in ${found.map((entry) => entry.setting).join(", ")}`,
    );
  }
  const archived = changes(
    before,
    await snapshot({
      "": {
        ...(await (await api()("https://api.github.com/repos/o/r")).json()),
        archived: true,
      },
    }),
  );
  assert.deepEqual(archived, [
    { setting: "repository › archived", previous: false, current: true },
  ]);
});

test("losing the ability to read a section is itself a change", async () => {
  const before = await snapshot();
  const after = await snapshot({
    "/rulesets?per_page=100&includes_parents=true": 403,
  });
  assert.deepEqual(after.rulesets, { unavailable: "HTTP 403" });
  const found = changes(before, after);
  assert.ok(found.some((entry) => entry.setting.startsWith("rulesets")));
});

test("key order is not a change, a removed rule is", () => {
  const record = {
    rulesets: { a: { rules: [{ type: "deletion" }, { type: "update" }] } },
  };
  assert.deepEqual(changes(record, stable(structuredClone(record))), []);
  const removed = structuredClone(record);
  removed.rulesets.a.rules.pop();
  assert.equal(changes(record, removed).length, 1);
});

test("the report names each setting and truncates long values", () => {
  assert.equal(renderChanges([], "Changed"), "Changed: none.\n");
  const long = {
    rules: Array.from({ length: 40 }, (_, n) => ({ type: `t${n}` })),
  };
  const markdown = renderChanges(
    [{ setting: "rulesets › a", previous: long, current: undefined }],
    "Changed",
  );
  assert.match(markdown, /^Changed: 1\./);
  assert.match(markdown, /\| rulesets › a \| `.{1,160}` \| `absent` \|/);
});

test("live rulesets are compared with the declarations, bypass list only when visible", async () => {
  const declarations = [branchPolicy];
  const same = await snapshot();
  assert.deepEqual(declaredDifferences(same, declarations), []);
  const { bypass_actors: _hidden, ...withoutBypass } = branchPolicy;
  const hidden = await snapshot({ "/rulesets/1": withoutBypass });
  assert.deepEqual(declaredDifferences(hidden, declarations), []);
  const weaker = await snapshot({
    "/rulesets/1": { ...branchPolicy, enforcement: "evaluate" },
  });
  assert.deepEqual(
    declaredDifferences(weaker, declarations).map((entry) => entry.setting),
    [`${branchPolicy.name} › enforcement`],
  );
  const missing = await snapshot({
    "/rulesets?per_page=100&includes_parents=true": [],
  });
  assert.deepEqual(declaredDifferences(missing, declarations), [
    { setting: branchPolicy.name, previous: "declared", current: undefined },
  ]);
});

test("the previous record is the newest earlier one from the same branch", () => {
  const artifact = (id, branch, created, extra = {}) => ({
    name: ARTIFACT,
    expired: false,
    created_at: created,
    workflow_run: { id, head_branch: branch },
    ...extra,
  });
  const artifacts = [
    artifact(5, "main", "2026-11-10T00:00:00Z"),
    artifact(4, "main", "2026-11-03T00:00:00Z"),
    artifact(3, "other", "2026-11-09T00:00:00Z"),
    artifact(2, "main", "2026-11-08T00:00:00Z", { expired: true }),
    artifact(1, "main", "2026-11-09T00:00:00Z", { name: "something-else" }),
  ];
  const pick = (branch, runId) =>
    previousArtifact(artifacts, { branch, runId })?.workflow_run.id;
  assert.equal(pick("main", 9), 5);
  // The run never compares against its own upload.
  assert.equal(pick("main", 5), 4);
  assert.equal(pick("other", 9), 3);
  assert.equal(pick("new-branch", 9), undefined);
});

test("compare exits non-zero only when something changed", async () => {
  const before = join(work, "before.json");
  const same = join(work, "same.json");
  const changed = join(work, "changed.json");
  const record = await snapshot();
  writeFileSync(before, JSON.stringify(record));
  writeFileSync(same, JSON.stringify(await snapshot()));
  writeFileSync(
    changed,
    JSON.stringify(await snapshot({ "/branches/main": { protected: false } })),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(run("compare", before, same).status, 0);
  const alarm = run("compare", before, changed);
  assert.equal(alarm.status, 1);
  assert.match(alarm.stdout, /default_branch_protected \| `true` \| `false`/);
  assert.equal(run("declared", before).status, 0);
  assert.equal(run("nonsense").status, 2);
});

test("the workflow records first, then alarms, with a read-only token", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["repository-settings"];
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  const runs = job.steps.map((step) => String(step.run ?? step.uses));
  const at = (pattern) => runs.findIndex((run) => pattern.test(run));
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
});
