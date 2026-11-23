#!/usr/bin/env node
// Deletes the historical `next` and `latest` versions of the published GHCR
// images, so the security workflow's published-image rows close their
// findings (docs/operators/ghcr-images.md, "Clearing the historical-tag
// alerts").
//
//   MODE=dry-run|delete GH_TOKEN=... node scripts/security/ghcr-historical-cleanup.mjs
//
// Only a version whose tags include `next` or `latest` is selected. A package
// is never deleted, and neither is an untagged or otherwise-tagged version. A
// version that is the package's last one is skipped and reported: deleting
// the last version deletes the package, and a missing package fails the scan
// row instead of closing it. `dry-run` (the default) lists what `delete`
// would do and changes nothing. Any API error fails the run, except a delete
// that finds the version already gone (404).
//
// The step summary goes to $GITHUB_STEP_SUMMARY when it is set.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

export const ORG = "OpenSesame-Labs";
/** The images security.yml scans as published; a test keeps them equal. */
export const PACKAGES = Object.freeze([
  "opensesame",
  "cli",
  "web-pwa",
  "control-plane",
]);
export const HISTORICAL_TAGS = Object.freeze(["next", "latest"]);
export const MODES = Object.freeze(["dry-run", "delete"]);

const API = "https://api.github.com";
const PAGE_SIZE = 100;
/** Pages read per package before the listing is treated as runaway. */
const MAX_PAGES = 50;

export class GhcrApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GhcrApiError";
    this.status = status;
  }
}

const versionsPath = (pkg) =>
  `/orgs/${ORG}/packages/container/${encodeURIComponent(pkg)}/versions`;

/** A clear reason for a failed call, naming the access it lacked. */
export function explainFailure(action, pkg, status, detail) {
  const what = `${action} ${ORG}/${pkg}`;
  const tail = detail ? ` (${detail})` : "";
  if (status === 401)
    return `${what}: HTTP 401, the token was rejected${tail}.`;
  if (status === 403)
    return action === "delete"
      ? `${what}: HTTP 403, this repository lacks admin access to the package. Grant it the Admin role under the package's settings, "Manage Actions access"${tail}.`
      : `${what}: HTTP 403, this repository lacks read access to the package. Add it under the package's settings, "Manage Actions access"${tail}.`;
  if (status === 404 && action === "list")
    return `${what}: HTTP 404, the package does not exist or is not visible to this repository's token${tail}.`;
  return `${what}: HTTP ${status}${tail}.`;
}

async function failureDetail(response) {
  try {
    const body = await response.json();
    return isString(body?.message) ? body.message : "";
  } catch {
    return "";
  }
}

/** The `rel="next"` URL of a GitHub Link header, or null. */
export function nextLink(header) {
  for (const part of String(header ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

/** A GitHub REST client over an injected fetch. */
export function githubClient({ token, fetch: fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error("GH_TOKEN is required.");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "opensesame-ghcr-historical-cleanup",
  };
  return {
    /** Every version of a container package, across all pages. */
    async listVersions(pkg) {
      const versions = [];
      let url = `${API}${versionsPath(pkg)}?per_page=${PAGE_SIZE}`;
      for (let page = 0; url; page += 1) {
        if (page >= MAX_PAGES)
          throw new GhcrApiError(
            `list ${ORG}/${pkg}: more than ${MAX_PAGES} pages of versions.`,
          );
        const response = await fetchImpl(url, { method: "GET", headers });
        if (!response.ok)
          throw new GhcrApiError(
            explainFailure(
              "list",
              pkg,
              response.status,
              await failureDetail(response),
            ),
            response.status,
          );
        const body = await response.json();
        if (!Array.isArray(body))
          throw new GhcrApiError(
            `list ${ORG}/${pkg}: the response is not a list of versions.`,
          );
        versions.push(...body);
        url = nextLink(response.headers.get("link"));
      }
      return versions;
    },
    /** Deletes one version; returns "deleted" or "already-gone" (404). */
    async deleteVersion(pkg, id) {
      const response = await fetchImpl(
        `${API}${versionsPath(pkg)}/${encodeURIComponent(String(id))}`,
        { method: "DELETE", headers },
      );
      if (response.status === 404) return "already-gone";
      if (!response.ok)
        throw new GhcrApiError(
          explainFailure(
            "delete",
            pkg,
            response.status,
            await failureDetail(response),
          ),
          response.status,
        );
      return "deleted";
    },
  };
}

/** The tags of a package version, as a list of strings. */
export function versionTags(version) {
  const tags = version?.metadata?.container?.tags;
  return Array.isArray(tags) ? tags.filter(isString) : [];
}

/** Versions carrying `next` or `latest`, each once. */
export function selectHistorical(versions) {
  const seen = new Set();
  return versions.filter((version) => {
    if (seen.has(version.id)) return false;
    const selected = versionTags(version).some((tag) =>
      HISTORICAL_TAGS.includes(tag),
    );
    if (selected) seen.add(version.id);
    return selected;
  });
}

/**
 * Plans and, in `delete` mode, carries out the cleanup of one package.
 * @returns {Promise<{ package: string, total: number, rows: object[] }>}
 */
export async function cleanPackage(client, pkg, mode) {
  const versions = await client.listVersions(pkg);
  let remaining = new Set(versions.map((version) => version.id)).size;
  const rows = [];
  for (const version of selectHistorical(versions)) {
    const row = {
      package: pkg,
      id: version.id,
      tags: versionTags(version),
      created_at: version.created_at ?? "",
    };
    if (remaining <= 1) {
      rows.push({ ...row, action: "skipped-last-version" });
      continue;
    }
    if (mode === "delete") {
      const outcome = await client.deleteVersion(pkg, version.id);
      rows.push({ ...row, action: outcome });
    } else {
      rows.push({ ...row, action: "would-delete" });
    }
    remaining -= 1;
  }
  return { package: pkg, total: versions.length, rows };
}

/**
 * Runs every package. A failing package is recorded and the others still
 * run; the result carries every error so the caller can fail the job.
 */
export async function run({
  client,
  mode,
  packages = PACKAGES,
  log = console.log,
}) {
  if (!MODES.includes(mode))
    throw new Error(`mode must be one of ${MODES.join(", ")}; got "${mode}".`);
  const results = [];
  const errors = [];
  for (const pkg of packages) {
    try {
      const result = await cleanPackage(client, pkg, mode);
      results.push(result);
      if (result.rows.length === 0)
        log(
          `${pkg}: no version tagged ${HISTORICAL_TAGS.join(" or ")} (${result.total} versions)`,
        );
      for (const row of result.rows)
        log(
          `${pkg}: version ${row.id} tags=[${row.tags.join(",")}] created_at=${row.created_at} -> ${row.action}`,
        );
    } catch (error) {
      if (!(error instanceof GhcrApiError)) throw error;
      errors.push(error.message);
      log(`::error::${error.message}`);
    }
  }
  return { mode, results, errors };
}

const ACTION_TEXT = {
  "would-delete": "would delete",
  deleted: "deleted",
  "already-gone": "already gone",
  "skipped-last-version": "skipped: last version of the package",
};

/** A Markdown step summary of a run. */
export function summaryMarkdown({ mode, results, errors }) {
  const lines = [
    `## GHCR historical tag cleanup (${mode})`,
    "",
    `Versions of \`ghcr.io/${ORG.toLowerCase()}/*\` tagged ${HISTORICAL_TAGS.map((tag) => `\`${tag}\``).join(" or ")}.`,
    "",
    "| Package | Version | Tags | Created | Action |",
    "|---|---|---|---|---|",
  ];
  for (const result of results) {
    if (result.rows.length === 0)
      lines.push(`| ${result.package} | none | | | nothing tagged |`);
    for (const row of result.rows)
      lines.push(
        `| ${row.package} | ${row.id} | ${row.tags.map((tag) => `\`${tag}\``).join(" ")} | ${row.created_at} | ${ACTION_TEXT[row.action] ?? row.action} |`,
      );
  }
  if (errors.length) {
    lines.push("", "### Errors", "");
    for (const error of errors) lines.push(`- ${error}`);
  }
  if (mode === "dry-run")
    lines.push(
      "",
      "Dry run: nothing was deleted. Run with mode `delete` to apply.",
    );
  else
    lines.push(
      "",
      "The next run of the security workflow uploads an empty report for each removed tag, which closes its alerts.",
    );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const mode = process.env.MODE || "dry-run";
  const client = githubClient({ token: process.env.GH_TOKEN });
  const outcome = await run({ client, mode });
  const summary = summaryMarkdown(outcome);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  if (outcome.errors.length) process.exit(1);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
