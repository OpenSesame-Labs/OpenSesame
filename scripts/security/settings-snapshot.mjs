#!/usr/bin/env node
// Records the repository settings a read-only token can see, and reports what
// changed since the previous record.
//
//   settings-snapshot.mjs collect  <out.json>
//   settings-snapshot.mjs previous <directory>        # prints found=true|false
//   settings-snapshot.mjs compare  <previous.json> <current.json>
//   settings-snapshot.mjs declared <current.json>
//
// GitHub's audit log cannot be streamed or queried from a repository on this
// plan, so nothing raised an alert when a ruleset was disabled, a deployment
// environment lost its reviewer, or the repository was archived. This records
// those settings on a schedule and fails the run when one changed.
//
// It only reads. A section the token cannot read is recorded as unavailable,
// so losing access shows up as a change too. Values here are setting names,
// rule parameters and numeric ids: none is a secret.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { policyView } from "../lib/github-governance.mjs";
import { isJsonObject } from "../lib/json-boundary.mjs";

export const ARTIFACT = "repository-settings";
export const FILE = "repository-settings.json";
const API = "https://api.github.com";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_FIELDS = [
  "visibility",
  "private",
  "archived",
  "disabled",
  "default_branch",
  "fork",
  "allow_forking",
  "web_commit_signoff_required",
];
const RULESET_FIELDS = [
  "name",
  "target",
  "source_type",
  "enforcement",
  "conditions",
  "rules",
];
const COMPARED = ["target", "enforcement", "conditions", "rules"];
const DECLARED = [
  "ops/github/default-branch.json",
  "ops/github/release-tags.json",
  "ops/github/release-tag-creation.json",
];

function pick(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
}

/** Same value with every object's keys in a fixed order. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

export function rulesetView(ruleset) {
  return {
    ...pick(ruleset, RULESET_FIELDS),
    // Only a token with write access to the ruleset is shown its bypass list.
    bypass_actors: ruleset.bypass_actors ?? "not visible to this token",
  };
}

export function environmentView(environment, branches) {
  const rules = (environment.protection_rules ?? []).map((rule) => ({
    type: rule.type,
    wait_timer: rule.wait_timer ?? null,
    prevent_self_review: rule.prevent_self_review ?? null,
    reviewers: (rule.reviewers ?? [])
      .map((entry) => `${entry.type}:${entry.reviewer?.id}`)
      .sort(),
  }));
  return {
    protection_rules: rules.sort((a, b) => (a.type < b.type ? -1 : 1)),
    deployment_branch_policy: environment.deployment_branch_policy ?? null,
    deployment_branches: branches
      .map((branch) => `${branch.type}:${branch.name}`)
      .sort(),
  };
}

/** Every path whose value differs, with both values. */
export function changes(previous, current, path = []) {
  if (isJsonObject(previous) && isJsonObject(current)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    return [...keys]
      .sort()
      .flatMap((key) => changes(previous[key], current[key], [...path, key]));
  }
  if (JSON.stringify(stable(previous)) === JSON.stringify(stable(current)))
    return [];
  return [{ setting: path.join(" › "), previous, current }];
}

function show(value) {
  if (value === undefined) return "absent";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export function renderChanges(found, heading, columns = ["Before", "Now"]) {
  if (found.length === 0) return `${heading}: none.\n`;
  const rows = found.map(
    (entry) =>
      `| ${entry.setting} | \`${show(entry.previous)}\` | \`${show(entry.current)}\` |`,
  );
  return [
    `${heading}: ${found.length}.`,
    "",
    `| Setting | ${columns[0]} | ${columns[1]} |`,
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Live rulesets against the declarations, leaving out what the token cannot see. */
export function declaredDifferences(snapshot, declarations) {
  const live = snapshot.rulesets ?? {};
  return declarations.flatMap((declared) => {
    const current = live[declared.name];
    if (!isJsonObject(current) || !Array.isArray(current.rules))
      return [{ setting: declared.name, previous: "declared", current }];
    // The bypass list is compared only when this token was shown it.
    const fields = Array.isArray(current.bypass_actors)
      ? [...COMPARED, "bypass_actors"]
      : COMPARED;
    return changes(
      pick(policyView(declared, declared), fields),
      pick(policyView(current, declared), fields),
      [declared.name],
    );
  });
}

async function request(path, token, fetcher = fetch) {
  const response = await fetcher(
    path.startsWith("http") ? path : `${API}${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "opensesame-settings-snapshot",
      },
    },
  );
  // The status is the diagnosis. A response body is never echoed.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function section(read) {
  try {
    return await read();
  } catch (error) {
    return { unavailable: error.message };
  }
}

/** The settings this token can read, in a fixed shape and order. */
export async function collect({ repository, token, fetcher }) {
  const get = async (path) =>
    (await request(`/repos/${repository}${path}`, token, fetcher)).json();
  const repo = await section(() => get(""));
  const branch = repo.default_branch ?? "main";
  return stable({
    repository: repo.unavailable ? repo : pick(repo, REPOSITORY_FIELDS),
    default_branch_protected: await section(
      async () =>
        (await get(`/branches/${encodeURIComponent(branch)}`)).protected,
    ),
    rulesets: await section(async () => {
      const listed = await get("/rulesets?per_page=100&includes_parents=true");
      const entries = [];
      for (const { id, name } of listed)
        entries.push([name, rulesetView(await get(`/rulesets/${id}`))]);
      return Object.fromEntries(entries);
    }),
    environments: await section(async () => {
      const { environments } = await get("/environments?per_page=100");
      const entries = [];
      for (const environment of environments) {
        const name = encodeURIComponent(environment.name);
        const { branch_policies: branches = [] } = await section(() =>
          get(`/environments/${name}/deployment-branch-policies?per_page=100`),
        );
        entries.push([
          environment.name,
          environmentView(environment, branches),
        ]);
      }
      return Object.fromEntries(entries);
    }),
  });
}

/** The newest earlier snapshot recorded on the same branch, if any. */
export function previousArtifact(artifacts, { branch, runId }) {
  return artifacts
    .filter((artifact) => artifact.name === ARTIFACT && !artifact.expired)
    .filter((artifact) => artifact.workflow_run?.head_branch === branch)
    .filter((artifact) => String(artifact.workflow_run?.id) !== String(runId))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

async function downloadPrevious(directory, env) {
  const listed = await request(
    `/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=${ARTIFACT}&per_page=100`,
    env.GH_TOKEN,
  );
  const { artifacts } = await listed.json();
  const artifact = previousArtifact(artifacts, {
    branch: env.GITHUB_REF_NAME,
    runId: env.GITHUB_RUN_ID,
  });
  if (!artifact) return false;
  const archive = await request(artifact.archive_download_url, env.GH_TOKEN);
  mkdirSync(directory, { recursive: true });
  const zip = join(directory, "previous.zip");
  writeFileSync(zip, Buffer.from(await archive.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip, FILE, "-d", directory]);
  return readdirSync(directory).includes(FILE);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

async function main([command, first, second], env) {
  if (command === "collect" && first) {
    const snapshot = await collect({
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
    });
    mkdirSync(dirname(resolve(first)), { recursive: true });
    writeFileSync(first, `${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }
  if (command === "previous" && first) {
    console.log(`found=${await downloadPrevious(first, env)}`);
    return 0;
  }
  if (command === "compare" && first && second) {
    const found = changes(readJson(first), readJson(second));
    console.log(
      renderChanges(found, "Settings changed since the previous record"),
    );
    return found.length === 0 ? 0 : 1;
  }
  if (command === "declared" && first) {
    const declarations = DECLARED.map((path) => readJson(join(root, path)));
    const found = declaredDifferences(readJson(first), declarations);
    console.log(
      renderChanges(found, "Live rulesets that differ from ops/github/", [
        "Declared",
        "Live",
      ]),
    );
    return 0;
  }
  console.error(
    "usage: settings-snapshot.mjs collect OUT | previous DIR | compare PREVIOUS CURRENT | declared CURRENT",
  );
  return 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(await main(process.argv.slice(2), process.env));
