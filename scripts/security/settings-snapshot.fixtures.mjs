// A fake GitHub API for one repository, shared by the settings-snapshot tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const BASE = "https://api.github.com/repos/o/r";
export const RULESETS = "/rulesets?per_page=100&includes_parents=true";
export const ENVIRONMENTS = "/environments?per_page=100";
export const BRANCH_POLICIES =
  "/environments/release/deployment-branch-policies?per_page=100";
export const ARTIFACTS =
  "/actions/artifacts?name=repository-settings&per_page=100";

export const declared = (name) =>
  JSON.parse(readFileSync(join(root, "ops/github", name), "utf8"));
export const branchPolicy = declared("default-branch.json");
/** The key the record files a ruleset under. */
export const rulesetKey = `${branchPolicy.name} [1]`;

export const REPOSITORY = {
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
};

export const RELEASE = {
  name: "release",
  updated_at: "2026-11-01T00:00:00Z",
  can_admins_bypass: false,
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
};

/** The same shape with every list empty: what a page past the end returns. */
function emptied(value) {
  if (Array.isArray(value)) return [];
  if (value === null || value === undefined || Number.isInteger(value))
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      Array.isArray(item) ? [] : item,
    ]),
  );
}

/**
 * A fetcher over fixed routes. A route mapped to a number answers that HTTP
 * status. A list route answers page 1; a later page is empty unless a route
 * names it (`…&page=2`).
 */
export function api(overrides = {}) {
  const routes = {
    "": REPOSITORY,
    "/branches/main": { name: "main", protected: true },
    [RULESETS]: [{ id: 1, name: branchPolicy.name }],
    "/rulesets/1": {
      ...branchPolicy,
      id: 1,
      updated_at: "2026-11-01T00:00:00Z",
    },
    [ENVIRONMENTS]: { environments: [RELEASE] },
    [BRANCH_POLICIES]: { branch_policies: [{ name: "main", type: "branch" }] },
    ...overrides,
  };
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    const path = url.slice(BASE.length);
    const paged = /&page=(\d+)$/.exec(path);
    const first = path.replace(/&page=\d+$/, "");
    const value =
      path in routes || !paged || paged[1] === "1"
        ? (routes[path] ?? routes[first])
        : emptied(routes[first]);
    if (Number.isInteger(value) || value === undefined)
      return { ok: false, status: value ?? 404 };
    return { ok: true, json: async () => value };
  };
  fetcher.seen = seen;
  return fetcher;
}
