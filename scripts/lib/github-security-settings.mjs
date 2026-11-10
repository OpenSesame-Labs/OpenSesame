// Pure comparison of the repository security settings declared in
// ops/github/repository-security.json against what the GitHub API reports.
// ops/github/security-settings.mjs does the reading and writing.
import { isJsonObject } from "./json-boundary.mjs";

const SECTIONS = [
  "permissions",
  "selected_actions",
  "workflow",
  "fork_pr_contributor_approval",
];

function pick(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key]]));
}

/**
 * Reduces raw API responses to the shape of the declaration, keeping only the
 * keys the declaration names so an unrelated live field is never drift.
 */
export function normalizeLive(expected, responses) {
  const analysis = responses.repo?.security_and_analysis ?? {};
  const actions = {
    permissions: responses.permissions,
    selected_actions: responses.selectedActions,
    workflow: responses.workflow,
    fork_pr_contributor_approval: responses.forkApproval,
  };
  return {
    security_and_analysis: Object.fromEntries(
      Object.keys(expected.security_and_analysis).map((key) => [
        key,
        analysis[key]?.status,
      ]),
    ),
    vulnerability_alerts: responses.vulnerabilityAlerts === true,
    private_vulnerability_reporting:
      responses.privateReporting?.enabled === true,
    immutable_releases: responses.immutableReleases?.enabled === true,
    actions: Object.fromEntries(
      SECTIONS.map((section) => [
        section,
        pick(actions[section], Object.keys(expected.actions[section])),
      ]),
    ),
  };
}

function same(expected, actual) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      JSON.stringify([...expected].sort()) ===
        JSON.stringify([...actual].sort())
    );
  }
  return expected === actual;
}

function compare(expected, actual, path, drift) {
  if (isJsonObject(expected)) {
    for (const key of Object.keys(expected))
      compare(expected[key], actual?.[key], [...path, key], drift);
    return;
  }
  if (!same(expected, actual))
    drift.push({ setting: path.join("."), expected, actual: actual ?? null });
}

/** Every declared setting whose live value differs; empty means conformant. */
export function settingsDrift(expected, live) {
  const drift = [];
  compare(expected, live, [], drift);
  return drift;
}

const ACTION_PATHS = {
  permissions: "actions/permissions",
  selected_actions: "actions/permissions/selected-actions",
  workflow: "actions/permissions/workflow",
  fork_pr_contributor_approval:
    "actions/permissions/fork-pr-contributor-approval",
};

/** The API writes that bring the drifted sections to their declared values. */
export function settingsWrites(expected, drift) {
  const drifted = (prefix) =>
    drift.some(
      (entry) =>
        entry.setting === prefix || entry.setting.startsWith(`${prefix}.`),
    );
  const writes = [];
  if (drifted("security_and_analysis")) {
    const body = Object.fromEntries(
      Object.entries(expected.security_and_analysis).map(([key, status]) => [
        key,
        { status },
      ]),
    );
    writes.push({
      method: "PATCH",
      path: "",
      body: { security_and_analysis: body },
    });
  }
  const toggles = {
    vulnerability_alerts: "vulnerability-alerts",
    private_vulnerability_reporting: "private-vulnerability-reporting",
    immutable_releases: "immutable-releases",
  };
  for (const [setting, path] of Object.entries(toggles)) {
    if (drifted(setting))
      writes.push({ method: expected[setting] ? "PUT" : "DELETE", path });
  }
  for (const section of SECTIONS) {
    if (drifted(`actions.${section}`))
      writes.push({
        method: "PUT",
        path: ACTION_PATHS[section],
        body: expected.actions[section],
      });
  }
  return writes;
}

/** Allow-list patterns for exactly the action repositories the workflows use. */
export function allowedActionPatterns(repositories) {
  return [...new Set(repositories)]
    .sort()
    .map((repository) => `${repository}@*`);
}
