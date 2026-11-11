import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BRANCH_POLICIES,
  ENVIRONMENTS,
  RELEASE,
  REPOSITORY,
  RULESETS,
  api,
  branchPolicy,
  rulesetKey,
} from "./settings-snapshot.fixtures.mjs";
import {
  changes,
  collect,
  declaredDifferences,
  renderChanges,
  stable,
} from "./settings-snapshot.mjs";

const script = fileURLToPath(
  new URL("./settings-snapshot.mjs", import.meta.url),
);
const work = mkdtempSync(join(tmpdir(), "opensesame-settings-"));
after(() => rmSync(work, { recursive: true, force: true }));

const snapshot = (overrides) =>
  collect({ repository: "o/r", token: "t", fetcher: api(overrides) });
const settings = (found) => found.map((entry) => entry.setting);

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
  for (const noise of ["pushed_at", "updated_at", "stargazers"])
    assert.equal(JSON.stringify(record).includes(noise), false, noise);
  assert.deepEqual(Object.keys(record.rulesets), [rulesetKey]);
  assert.deepEqual(record.environments.release, {
    can_admins_bypass: false,
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
  assert.deepEqual(changes(record, await snapshot()), []);
});

test("a bypass list the token is not shown is recorded as not visible", async () => {
  const { bypass_actors: _hidden, ...withoutBypass } = branchPolicy;
  const record = await snapshot({ "/rulesets/1": withoutBypass });
  assert.equal(
    record.rulesets[rulesetKey].bypass_actors,
    "not visible to this token",
  );
});

test("the changes that matter are each reported with both values", async () => {
  const before = await snapshot();
  const cases = [
    [
      { "/rulesets/1": { ...branchPolicy, enforcement: "disabled" } },
      `rulesets › ${rulesetKey} › enforcement`,
    ],
    [{ [RULESETS]: [] }, `rulesets › ${rulesetKey}`],
    [
      { "": { ...REPOSITORY, visibility: "private", private: true } },
      "repository › visibility",
    ],
    [{ "/branches/main": { protected: false } }, "default_branch_protected"],
    [{ [ENVIRONMENTS]: { environments: [] } }, "environments › release"],
    [
      {
        [ENVIRONMENTS]: {
          environments: [{ ...RELEASE, can_admins_bypass: true }],
        },
      },
      "environments › release › can_admins_bypass",
    ],
    [
      {
        [BRANCH_POLICIES]: {
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
    const found = settings(changes(before, await snapshot(overrides)));
    assert.ok(found.includes(setting), `${setting} not in ${found.join(", ")}`);
  }
  assert.deepEqual(
    changes(before, await snapshot({ "": { ...REPOSITORY, archived: true } })),
    [{ setting: "repository › archived", previous: false, current: true }],
  );
});

test("losing the ability to read a section is itself a change", async () => {
  const before = await snapshot();
  const unreadable = await snapshot({ [RULESETS]: 403 });
  assert.deepEqual(unreadable.rulesets, { unavailable: "HTTP 403" });
  assert.ok(
    settings(changes(before, unreadable)).some((s) => s.startsWith("rulesets")),
  );
});

test("an unreadable branch-policy list is not recorded as an empty one", async () => {
  const empty = await snapshot({ [BRANCH_POLICIES]: { branch_policies: [] } });
  const unreadable = await snapshot({ [BRANCH_POLICIES]: 403 });
  assert.deepEqual(empty.environments.release.deployment_branches, []);
  assert.deepEqual(unreadable.environments.release.deployment_branches, {
    unavailable: "HTTP 403",
  });
  assert.deepEqual(settings(changes(empty, unreadable)), [
    "environments › release › deployment_branches",
  ]);
});

test("two rulesets that share a name are both recorded", async () => {
  const twins = {
    [RULESETS]: [
      { id: 1, name: branchPolicy.name },
      { id: 2, name: branchPolicy.name },
    ],
    "/rulesets/2": { ...branchPolicy, id: 2, source_type: "Organization" },
  };
  const before = await snapshot(twins);
  assert.equal(Object.keys(before.rulesets).length, 2);
  const after = await snapshot({
    ...twins,
    "/rulesets/1": { ...branchPolicy, id: 1, enforcement: "disabled" },
  });
  assert.deepEqual(settings(changes(before, after)), [
    `rulesets › ${rulesetKey} › enforcement`,
  ]);
  // The declared policy names one ruleset; two live ones is reported.
  assert.deepEqual(declaredDifferences(before, [branchPolicy])[0], {
    setting: branchPolicy.name,
    previous: "declared once",
    current: "2 live rulesets share this name",
  });
});

test("a list longer than one page is read to its end", async () => {
  const many = Array.from({ length: 100 }, (_, n) => ({
    ...RELEASE,
    name: `env-${n}`,
  }));
  const last = { ...RELEASE, name: "last" };
  const routes = (final) => ({
    [ENVIRONMENTS]: { environments: many },
    [`${ENVIRONMENTS}&page=2`]: { environments: [final] },
  });
  const before = await snapshot(routes(last));
  assert.equal(Object.keys(before.environments).length, 101);
  const after = await snapshot(routes({ ...last, can_admins_bypass: true }));
  assert.deepEqual(settings(changes(before, after)), [
    "environments › last › can_admins_bypass",
  ]);
});

test("a changed rule is named down to the parameter", async () => {
  const before = await snapshot();
  const weaker = structuredClone(branchPolicy);
  const review = weaker.rules.find((rule) => rule.type === "pull_request");
  const declared = review.parameters.required_approving_review_count;
  review.parameters.required_approving_review_count = 0;
  weaker.rules = weaker.rules.filter((rule) => rule.type !== "deletion");
  const after = await snapshot({ "/rulesets/1": weaker });
  const rules = `rulesets › ${rulesetKey} › rules`;
  assert.deepEqual(changes(before, after), [
    {
      setting: `${rules} › deletion`,
      previous: { type: "deletion" },
      current: undefined,
    },
    {
      setting: `${rules} › pull_request › parameters › required_approving_review_count`,
      previous: declared,
      current: 0,
    },
  ]);
  const noReviewer = await snapshot({
    [ENVIRONMENTS]: {
      environments: [
        {
          ...RELEASE,
          protection_rules: [{ type: "required_reviewers", reviewers: [] }],
        },
      ],
    },
  });
  assert.ok(
    settings(changes(before, noReviewer)).includes(
      "environments › release › protection_rules › required_reviewers › reviewers",
    ),
  );
  // Two entries of one type stay distinct instead of one hiding the other.
  const twice = [
    { type: "t", n: 1 },
    { type: "t", n: 2 },
  ];
  const edited = [
    { type: "t", n: 1 },
    { type: "t", n: 3 },
  ];
  assert.deepEqual(settings(changes({ r: twice }, { r: edited })), [
    "r › t #1 › n",
  ]);
});

test("an environment open to every branch has no branch list to read", async () => {
  const open = { ...RELEASE, name: "open", deployment_branch_policy: null };
  const fetcher = api({ [ENVIRONMENTS]: { environments: [open] } });
  const record = await collect({ repository: "o/r", token: "t", fetcher });
  assert.deepEqual(record.environments.open.deployment_branches, []);
  assert.equal(record.environments.open.deployment_branch_policy, null);
  assert.equal(
    fetcher.seen.some(({ url }) => url.includes("deployment-branch-policies")),
    false,
  );
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

test("the report names each setting, truncates long values and stays in its cell", () => {
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
  // A name or value from a record cannot start a line, a cell or a code span.
  const hostile = renderChanges(
    [
      {
        setting: "a\n::error::x | y `z`",
        previous: "p`q|r",
        current: "line\nbreak",
      },
    ],
    "Changed",
  );
  const row = hostile.split("\n").filter((line) => line.includes("error"));
  assert.equal(row.length, 1);
  assert.equal(row[0].startsWith("| a "), true);
  assert.equal(row[0].split("|").length, 5);
  assert.equal(row[0].split("`").length, 5);
});

test("live rulesets are compared with the declarations, bypass list only when visible", async () => {
  const declarations = [branchPolicy];
  assert.deepEqual(declaredDifferences(await snapshot(), declarations), []);
  const { bypass_actors: _hidden, ...withoutBypass } = branchPolicy;
  const hidden = await snapshot({ "/rulesets/1": withoutBypass });
  assert.deepEqual(declaredDifferences(hidden, declarations), []);
  const weaker = await snapshot({
    "/rulesets/1": { ...branchPolicy, enforcement: "evaluate" },
  });
  assert.deepEqual(settings(declaredDifferences(weaker, declarations)), [
    `${rulesetKey} › enforcement`,
  ]);
  const missing = await snapshot({ [RULESETS]: [] });
  assert.deepEqual(declaredDifferences(missing, declarations), [
    { setting: branchPolicy.name, previous: "declared", current: undefined },
  ]);
  const unreadable = await snapshot({ [RULESETS]: 403 });
  assert.equal(declaredDifferences(unreadable, declarations).length, 1);
});

test("compare exits non-zero only when something changed", async () => {
  const paths = Object.fromEntries(
    ["before", "same", "changed"].map((name) => [
      name,
      join(work, `${name}.json`),
    ]),
  );
  writeFileSync(paths.before, JSON.stringify(await snapshot()));
  writeFileSync(paths.same, JSON.stringify(await snapshot()));
  writeFileSync(
    paths.changed,
    JSON.stringify(await snapshot({ "/branches/main": { protected: false } })),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(run("compare", paths.before, paths.same).status, 0);
  const alarm = run("compare", paths.before, paths.changed);
  assert.equal(alarm.status, 1);
  assert.match(alarm.stdout, /default_branch_protected \| `true` \| `false`/);
  assert.equal(run("declared", paths.before).status, 0);
  assert.equal(run("nonsense").status, 2);
});
