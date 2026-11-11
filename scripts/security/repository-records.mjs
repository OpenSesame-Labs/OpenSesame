#!/usr/bin/env node
// Exports what a clone of the repository does not hold: issues, pull requests,
// the comments on them, and pull request reviews with their decisions.
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
// Reviews have no repository-wide list. One REST call per pull request would
// spend the job token's hourly allowance, so they are read through GraphQL,
// a hundred pull requests per query.
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

/** One authenticated request to GitHub's API; `body` makes it a POST. */
async function call(url, token, fetcher, body) {
  // The token goes to GitHub's API and nowhere else, whatever a link says.
  if (!url.startsWith(`${API}/`)) throw new Error("not a GitHub API address");
  const init = {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "opensesame-repository-records",
    },
  };
  if (body) {
    init.method = "POST";
    init.body = JSON.stringify(body);
  }
  const response = await fetcher(url, init);
  // The status is the diagnosis. A response body is never echoed.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** Every record of a paged list, following the server's own next links. */
export async function* records(first, token, fetcher = fetch) {
  let url = first;
  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) throw new Error("list did not end");
    const response = await call(url, token, fetcher);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("unexpected response shape");
    yield* batch;
    url = nextLink(response.headers.get("link"));
  }
}

const REVIEW =
  "databaseId author { login } state body submittedAt commit { oid } url";
const REVIEWS = `pageInfo { hasNextPage endCursor } nodes { ${REVIEW} }`;
export const PULL_REVIEWS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number reviews(first: 100) { ${REVIEWS} } }
    }
  }
}`;
export const MORE_REVIEWS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviews(first: 100, after: $after) { ${REVIEWS} } }
  }
}`;

/** The repository object a GraphQL query returns. */
async function graphql(query, variables, token, fetcher) {
  const response = await call(`${API}/graphql`, token, fetcher, {
    query,
    variables,
  });
  const { data, errors } = await response.json();
  // An error message can quote the request, so none is echoed.
  if (errors?.length || !data?.repository) throw new Error("GraphQL refused");
  return data.repository;
}

/** Every page of a GraphQL connection, from `after` on. */
async function* connection(page, after = null) {
  let cursor = after;
  for (let count = 0; ; count += 1) {
    if (count >= MAX_PAGES) throw new Error("list did not end");
    const current = await page(cursor);
    yield current;
    if (!current.pageInfo.hasNextPage) return;
    cursor = current.pageInfo.endCursor;
  }
}

/** A review in the field names the REST API uses for one. */
const review = (pull) => (node) => ({
  pull_request: pull,
  id: node.databaseId,
  user: node.author?.login ?? null,
  state: node.state,
  body: node.body,
  submitted_at: node.submittedAt,
  commit_id: node.commit?.oid ?? null,
  html_url: node.url,
});

/** Every review of every pull request, oldest pull request first. */
export async function* reviews(repository, token, fetcher = fetch) {
  const [owner, name] = repository.split("/");
  const ask = (query, variables) =>
    graphql(query, { owner, name, ...variables }, token, fetcher);
  const pulls = connection(
    async (after) => (await ask(PULL_REVIEWS, { after })).pullRequests,
  );
  for await (const { nodes } of pulls) {
    for (const { number, reviews: first } of nodes) {
      yield* first.nodes.map(review(number));
      if (!first.pageInfo.hasNextPage) continue;
      const rest = connection(
        async (after) =>
          (await ask(MORE_REVIEWS, { number, after })).pullRequest.reviews,
        first.pageInfo.endCursor,
      );
      for await (const more of rest) yield* more.nodes.map(review(number));
    }
  }
}

/** Writes one list to a file, one record per line, and returns its count. */
async function writeList(path, list) {
  const file = openSync(path, "w");
  let count = 0;
  try {
    for await (const record of list) {
      writeSync(file, `${JSON.stringify(record)}\n`);
      count += 1;
    }
  } finally {
    closeSync(file);
  }
  return count;
}

/** Writes each list to `<directory>/<name>.ndjson` and returns the counts. */
export async function exportRecords({ repository, token, directory, fetcher }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  mkdirSync(directory, { recursive: true });
  const sources = [
    ...LISTS.map(({ name, path }) => [
      name,
      () => records(`${API}/repos/${repository}${path}`, token, fetcher),
    ]),
    ["reviews", () => reviews(repository, token, fetcher)],
  ];
  const counts = {};
  for (const [name, list] of sources)
    counts[name] = await writeList(join(directory, `${name}.ndjson`), list());
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
