#!/usr/bin/env node
// Exports what a clone of the repository does not hold: issues, pull requests
// and the comments on them.
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/name \
//     node scripts/security/repository-records.mjs export <directory>
//
// Every clone carries the full source history, and the settings can be
// re-applied from ops/github/. Issues, pull requests and review discussion
// live only on GitHub. This writes them as newline-delimited JSON, one record
// per line, with a manifest of the counts, so the scheduled run can keep a
// copy and the owner can store one elsewhere.
//
// It only reads. An empty or truncated export fails instead of being kept.
import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const MAX_PAGES = 2000;
// Oldest first, so a record created during the export lands at the end
// rather than shifting a page boundary.
const ORDER = "per_page=100&sort=created&direction=asc";
export const LISTS = [
  { name: "issues", path: `/issues?state=all&${ORDER}` },
  { name: "issue-comments", path: `/issues/comments?${ORDER}` },
  { name: "review-comments", path: `/pulls/comments?${ORDER}` },
];

/** The address of the next page from a Link header, or undefined at the end. */
export function nextLink(header) {
  for (const part of (header ?? "").split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

/** Every record of a paged list, following the server's own next links. */
export async function* records(first, token, fetcher = fetch) {
  let url = first;
  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) throw new Error("list did not end");
    // The token goes to GitHub's API and nowhere else, whatever a link says.
    if (!url.startsWith(`${API}/`)) throw new Error("not a GitHub API address");
    const response = await fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "opensesame-repository-records",
      },
    });
    // The status is the diagnosis. A response body is never echoed.
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("unexpected response shape");
    yield* batch;
    url = nextLink(response.headers.get("link"));
  }
}

/** Writes each list to `<directory>/<name>.ndjson` and returns the counts. */
export async function exportRecords({ repository, token, directory, fetcher }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  mkdirSync(directory, { recursive: true });
  const counts = {};
  for (const { name, path } of LISTS) {
    const file = openSync(join(directory, `${name}.ndjson`), "w");
    let count = 0;
    try {
      const from = `${API}/repos/${repository}${path}`;
      for await (const record of records(from, token, fetcher)) {
        writeSync(file, `${JSON.stringify(record)}\n`);
        count += 1;
      }
    } finally {
      closeSync(file);
    }
    counts[name] = count;
  }
  // A repository with pull requests always has issues to list. Nothing at
  // all means the export did not work, not that there is nothing to keep.
  if (counts.issues === 0) throw new Error("no issues or pull requests listed");
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({ repository, counts }, null, 2)}\n`,
  );
  return counts;
}

async function main([command, directory], env) {
  if (command !== "export" || !directory) {
    console.error("usage: repository-records.mjs export DIRECTORY");
    return 2;
  }
  const counts = await exportRecords({
    repository: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
    directory: resolve(directory),
  });
  const line = Object.entries(counts)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  console.log(`Repository records exported: ${line}.`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(await main(process.argv.slice(2), process.env));
