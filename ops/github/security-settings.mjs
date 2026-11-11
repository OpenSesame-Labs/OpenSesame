// Reads, applies and verifies the repository security settings declared in
// repository-security.json: secret scanning and push protection, Dependabot
// alerts and security updates, private vulnerability reporting, immutable
// releases, and the GitHub Actions policy (allowed actions, SHA pinning,
// read-only default token, approval for outside contributors).
//
//   node ops/github/security-settings.mjs --dry-run   # read and print drift
//   node ops/github/security-settings.mjs --apply     # write drifted sections
//   node ops/github/security-settings.mjs --verify    # fail on any drift
//
// Apply needs repository administration. A checked-in declaration, a dry run
// or an HTTP 403 is not evidence that a setting is live; only --verify is.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  normalizeLive,
  settingsDrift,
  settingsWrites,
} from "../../scripts/lib/github-security-settings.mjs";
import { readString } from "../../scripts/lib/json-boundary.mjs";

const repository = "OpenSesame-Labs/OpenSesame";
const root = `repos/${repository}`;
const { $comment: _comment, ...expected } = JSON.parse(
  readFileSync(new URL("./repository-security.json", import.meta.url), "utf8"),
);
const mode = process.argv[2] ?? "--dry-run";
if (
  !["--dry-run", "--apply", "--verify"].includes(mode) ||
  process.argv.length > 3
) {
  throw new Error(
    "Usage: node ops/github/security-settings.mjs [--dry-run|--apply|--verify]",
  );
}

function gh(path, method, body) {
  const args = ["api", path, "--method", method, "--include"];
  if (body) args.push("--input", "-");
  const options = {
    encoding: "utf8",
    input: body ? JSON.stringify(body) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  };
  let output;
  try {
    output = execFileSync("gh", args, options);
  } catch (error) {
    output = readString(error?.stdout) ?? "";
  }
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(output)?.[1] ?? 0);
  const text = output
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join("\n\n")
    .trim();
  return { status, text };
}

// gh diagnostics and error bodies can include configuration; print neither.
function api(path, method = "GET", body = undefined) {
  const { status, text } = gh(path ? `${root}/${path}` : root, method, body);
  if (status < 200 || status > 299)
    throw new Error(
      `GitHub ${method} ${path || "repository"} returned ${status || "no response"}; check repository administration permission`,
    );
  return text ? JSON.parse(text) : null;
}

/** For endpoints that answer 404 when the feature is off. */
function enabled(path) {
  const { status, text } = gh(`${root}/${path}`, "GET");
  if (status === 404) return { enabled: false };
  if (status === 204) return { enabled: true };
  if (status !== 200)
    throw new Error(`GitHub GET ${path} returned ${status || "no response"}`);
  return text ? JSON.parse(text) : { enabled: true };
}

function inspect() {
  // The allow-list endpoint answers only while the policy is `selected`. Under
  // any other policy the list is read as absent, which is drift, so --apply
  // sets the policy first and then writes the list.
  const permissions = api("actions/permissions");
  return normalizeLive(expected, {
    repo: api(""),
    vulnerabilityAlerts: enabled("vulnerability-alerts").enabled,
    privateReporting: enabled("private-vulnerability-reporting"),
    immutableReleases: enabled("immutable-releases"),
    permissions,
    selectedActions:
      permissions?.allowed_actions === "selected"
        ? api("actions/permissions/selected-actions")
        : undefined,
    workflow: api("actions/permissions/workflow"),
    forkApproval: api("actions/permissions/fork-pr-contributor-approval"),
  });
}

let drift = settingsDrift(expected, inspect());
if (mode === "--dry-run") {
  console.log(
    JSON.stringify(
      { drift, proposed: settingsWrites(expected, drift) },
      null,
      2,
    ),
  );
} else {
  if (mode === "--apply") {
    for (const write of settingsWrites(expected, drift))
      api(write.path, write.method, write.body);
    drift = settingsDrift(expected, inspect());
  }
  if (drift.length > 0) {
    console.error(JSON.stringify({ verified: false, drift }, null, 2));
    throw new Error(
      "GitHub security settings verification failed; inspect drift before retrying",
    );
  }
  console.log(JSON.stringify({ verified: true, ...expected }));
}
