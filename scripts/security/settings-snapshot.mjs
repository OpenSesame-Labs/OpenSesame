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
//
// The previous record is trusted only when this repository's own run of this
// workflow uploaded it. Any workflow run, including one for a pull request
// from a fork, can upload an artifact under any name.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { policyView } from "../lib/github-governance.mjs";
import { isJsonObject } from "../lib/json-boundary.mjs";
import { changes, renderChanges, stable } from "./settings-diff.mjs";

export { changes, renderChanges, stable };

export const ARTIFACT = "repository-settings";
export const FILE = "repository-settings.json";
export const WORKFLOW = ".github/workflows/security.yml";
const API = "https://api.github.com";
const PAGE = 100;
// A record is a few kilobytes; its archive is refused well before memory is.
export const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_PAGES = 50;
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

export function rulesetView(ruleset) {
  return {
    ...pick(ruleset, RULESET_FIELDS),
    // Only a token with write access to the ruleset is shown its bypass list.
    bypass_actors: ruleset.bypass_actors ?? "not visible to this token",
  };
}

export function environmentView(environment, branches) {
  // A branch-policy list that could not be read stays visibly unread.
  const deployment = Array.isArray(branches)
    ? branches.map((branch) => `${branch.type}:${branch.name}`).sort()
    : branches;
  const rules = (environment.protection_rules ?? []).map((rule) => ({
    type: rule.type,
    wait_timer: rule.wait_timer ?? null,
    prevent_self_review: rule.prevent_self_review ?? null,
    reviewers: (rule.reviewers ?? [])
      .map((entry) => `${entry.type}:${entry.reviewer?.id}`)
      .sort(),
  }));
  return {
    can_admins_bypass: environment.can_admins_bypass ?? null,
    protection_rules: rules.sort((a, b) => (a.type < b.type ? -1 : 1)),
    deployment_branch_policy: environment.deployment_branch_policy ?? null,
    deployment_branches: deployment,
  };
}

/** Live rulesets against the declarations, leaving out what the token cannot see. */
export function declaredDifferences(snapshot, declarations) {
  const live = Object.entries(snapshot.rulesets ?? {}).filter(
    ([, ruleset]) => isJsonObject(ruleset) && Array.isArray(ruleset.rules),
  );
  return declarations.flatMap((declared) => {
    const named = live.filter(([, ruleset]) => ruleset.name === declared.name);
    if (named.length === 0)
      return [
        { setting: declared.name, previous: "declared", current: undefined },
      ];
    const shared =
      named.length === 1
        ? []
        : [
            {
              setting: declared.name,
              previous: "declared once",
              current: `${named.length} live rulesets share this name`,
            },
          ];
    return shared.concat(
      named.flatMap(([key, current]) => {
        // The bypass list is compared only when this token was shown it.
        const fields = Array.isArray(current.bypass_actors)
          ? [...COMPARED, "bypass_actors"]
          : COMPARED;
        return changes(
          pick(policyView(declared, declared), fields),
          pick(policyView(current, declared), fields),
          [key],
        );
      }),
    );
  });
}

async function request(url, token, fetcher = fetch) {
  // The token goes to GitHub's API and nowhere else, whatever a response says.
  if (!url.startsWith(`${API}/`)) throw new Error("not a GitHub API address");
  const response = await fetcher(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "opensesame-settings-snapshot",
    },
  });
  // The status is the diagnosis. A response body is never echoed.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** Every item of a paged list. `key` names the array in a wrapped response. */
async function pages(read, path, key) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await read(`${path}&page=${page}`);
    const batch = key ? body[key] : body;
    if (!Array.isArray(batch)) throw new Error("unexpected response shape");
    items.push(...batch);
    if (batch.length < PAGE) return items;
  }
  // A list too long to read in full is unread, never silently cut short.
  throw new Error(`more than ${MAX_PAGES * PAGE} entries`);
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
    (await request(`${API}/repos/${repository}${path}`, token, fetcher)).json();
  const repo = await section(() => get(""));
  const branch = repo.default_branch ?? "main";
  return stable({
    repository: repo.unavailable ? repo : pick(repo, REPOSITORY_FIELDS),
    default_branch_protected: await section(
      async () =>
        (await get(`/branches/${encodeURIComponent(branch)}`)).protected,
    ),
    rulesets: await section(async () => {
      const listed = await pages(
        get,
        `/rulesets?per_page=${PAGE}&includes_parents=true`,
      );
      const entries = [];
      // Keyed by name and id: two rulesets may share a name, and one that is
      // deleted and recreated is a different ruleset.
      for (const { id, name } of listed)
        entries.push([
          `${name} [${id}]`,
          rulesetView(await get(`/rulesets/${id}`)),
        ]);
      return Object.fromEntries(entries);
    }),
    environments: await section(async () => {
      const environments = await pages(
        get,
        `/environments?per_page=${PAGE}`,
        "environments",
      );
      const entries = [];
      for (const environment of environments) {
        const name = encodeURIComponent(environment.name);
        // Only an environment with a custom list has one to read.
        const custom =
          environment.deployment_branch_policy?.custom_branch_policies;
        const branches = custom
          ? await section(() =>
              pages(
                get,
                `/environments/${name}/deployment-branch-policies?per_page=${PAGE}`,
                "branch_policies",
              ),
            )
          : [];
        entries.push([
          environment.name,
          environmentView(environment, branches),
        ]);
      }
      return Object.fromEntries(entries);
    }),
  });
}

/** Earlier records uploaded from this repository's own branch, newest first. */
export function previousArtifacts(artifacts, { branch, runId }) {
  return artifacts
    .filter((artifact) => artifact.name === ARTIFACT && !artifact.expired)
    .filter((artifact) => {
      const run = artifact.workflow_run ?? {};
      return (
        run.head_branch === branch &&
        String(run.id) !== String(runId) &&
        // A pull request from a fork runs in this repository with the fork
        // as its head, and may name its branch anything.
        run.repository_id !== undefined &&
        run.head_repository_id === run.repository_id
      );
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Whether the run that uploaded a record was this workflow's scheduled run,
 * not another. A hand-started run is not a baseline: anyone who can start it
 * could otherwise make a changed setting the record the next scheduled run
 * compares against, and only they would see the run fail. A scheduled run
 * only ever runs on the default branch, so a tag that happens to share the
 * branch's name cannot supply one either.
 */
export function trustedRun(run, { branch }) {
  return (
    run?.path === WORKFLOW &&
    run.head_branch === branch &&
    run.event === "schedule"
  );
}

/** Every setting path the record holds as unavailable rather than read. */
export function unreadable(record, path = []) {
  if (!isJsonObject(record)) return [];
  if ("unavailable" in record)
    return [
      { setting: path.join(" › ") || "record", reason: record.unavailable },
    ];
  return Object.entries(record).flatMap(([key, value]) =>
    unreadable(value, [...path, key]),
  );
}

/** The newest trusted earlier record, or undefined. */
export async function previousArtifact({
  repository,
  token,
  branch,
  runId,
  fetcher,
}) {
  const get = async (path) =>
    (await request(`${API}/repos/${repository}${path}`, token, fetcher)).json();
  const artifacts = await pages(
    get,
    `/actions/artifacts?name=${ARTIFACT}&per_page=${PAGE}`,
    "artifacts",
  );
  for (const artifact of previousArtifacts(artifacts, { branch, runId })) {
    const run = await get(`/actions/runs/${artifact.workflow_run.id}`);
    if (trustedRun(run, { branch })) return artifact;
  }
  return undefined;
}

async function downloadPrevious(directory, env) {
  const artifact = await previousArtifact({
    repository: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
    branch: env.GITHUB_REF_NAME,
    runId: env.GITHUB_RUN_ID,
  });
  if (!artifact) return false;
  const archive = await request(
    `${API}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${Number(artifact.id)}/zip`,
    env.GH_TOKEN,
  );
  return extractRecord(directory, Buffer.from(await archive.arrayBuffer()));
}

/**
 * Unpacks the record, and only the record, from an artifact archive into
 * `directory`, and says whether there was one. An archive can carry a link in
 * the record's place, which reading would follow out of the directory, so
 * anything but a regular file is refused.
 */
export function extractRecord(directory, bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new Error("previous record archive is too large");
  mkdirSync(directory, { recursive: true });
  const zip = join(directory, "previous.zip");
  writeFileSync(zip, bytes);
  try {
    execFileSync("unzip", ["-o", "-q", zip, FILE, "-d", directory], {
      stdio: "ignore",
    });
  } catch (error) {
    // unzip exits 11 when the archive holds no such member.
    if (error.status === 11) return false;
    throw new Error("previous record archive is unreadable");
  }
  let entry;
  try {
    entry = lstatSync(join(directory, FILE));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!entry.isFile()) throw new Error("previous record is not a regular file");
  return true;
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
  if (command === "readable" && first) {
    // A section that cannot be read compares equal to itself on every run,
    // so it would never raise the alarm. It fails the run instead.
    const missing = unreadable(readJson(first));
    for (const { setting, reason } of missing)
      console.log(`Unreadable: ${setting} (${reason})`);
    if (missing.length === 0) console.log("Every section was read.");
    return missing.length === 0 ? 0 : 1;
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
    "usage: settings-snapshot.mjs collect OUT | previous DIR | compare PREVIOUS CURRENT | readable CURRENT | declared CURRENT",
  );
  return 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(await main(process.argv.slice(2), process.env));
