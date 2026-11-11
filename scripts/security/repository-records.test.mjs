import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  LISTS,
  MORE_REVIEWS,
  PULL_REVIEWS,
  exportRecords,
  nextLink,
  records,
  reviews,
} from "./repository-records.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "opensesame-records-"));
after(() => rmSync(work, { recursive: true, force: true }));
const API = "https://api.github.com";
const BASE = `${API}/repos/o/r`;
const NO_PULLS = {
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    },
  },
};

/**
 * A fake API: each list is an array of pages, linked the way GitHub links.
 * `graphql` answers a parsed GraphQL request body.
 */
function api(lists, { status, graphql = () => NO_PULLS } = {}) {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    if (status) return { ok: false, status };
    if (url === `${API}/graphql`)
      return { ok: true, json: async () => graphql(JSON.parse(init.body)) };
    const [address, cursor = "0"] = url.split("&after=");
    const list = LISTS.find(({ path }) => address === `${BASE}${path}`);
    const pages = lists[list.name] ?? [[]];
    const index = Number(cursor);
    const next =
      index + 1 < pages.length
        ? `<${address}&after=${index + 1}>; rel="next", <${address}>; rel="first"`
        : `<${address}>; rel="first"`;
    return {
      ok: true,
      headers: new Headers({ link: next }),
      json: async () => pages[index],
    };
  };
  fetcher.seen = seen;
  return fetcher;
}

const run = (lists, options) => {
  const directory = mkdtempSync(join(work, "out-"));
  const fetcher = api(lists, options);
  return {
    directory,
    fetcher,
    done: exportRecords({ repository: "o/r", token: "t", directory, fetcher }),
  };
};

test("the next page is taken from the server's link header only", () => {
  assert.equal(
    nextLink(
      '<https://api.github.com/a?after=x>; rel="next", <https://api.github.com/a>; rel="first"',
    ),
    "https://api.github.com/a?after=x",
  );
  assert.equal(nextLink('<https://api.github.com/a>; rel="prev"'), undefined);
  assert.equal(nextLink(null), undefined);
  assert.equal(nextLink(""), undefined);
});

test("every page of every list is written, one record per line", async () => {
  const { directory, fetcher, done } = run({
    issues: [[{ number: 1 }, { number: 2 }], [{ number: 3 }]],
    "issue-comments": [[{ id: 10, body: "line one\nline two" }]],
    "review-comments": [[]],
  });
  assert.deepEqual(await done, {
    issues: 3,
    "issue-comments": 1,
    "review-comments": 0,
    reviews: 0,
  });
  assert.deepEqual(readdirSync(directory).sort(), [
    "issue-comments.ndjson",
    "issues.ndjson",
    "manifest.json",
    "review-comments.ndjson",
    "reviews.ndjson",
  ]);
  const lines = (name) =>
    readFileSync(join(directory, name), "utf8").trimEnd().split("\n");
  assert.deepEqual(
    lines("issues.ndjson").map((line) => JSON.parse(line)),
    [{ number: 1 }, { number: 2 }, { number: 3 }],
  );
  // A body with a line break is still one line.
  assert.equal(lines("issue-comments.ndjson").length, 1);
  assert.equal(
    readFileSync(join(directory, "review-comments.ndjson"), "utf8"),
    "",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
    {
      repository: "o/r",
      counts: {
        issues: 3,
        "issue-comments": 1,
        "review-comments": 0,
        reviews: 0,
      },
    },
  );
  // All issues and pull requests, open and closed, oldest first.
  assert.match(
    fetcher.seen[0].url,
    /\/issues\?state=all&per_page=100&sort=created&direction=asc$/,
  );
  for (const { url, init } of fetcher.seen) {
    assert.ok(url.startsWith(`${BASE}/`) || url === `${API}/graphql`);
    assert.equal(init.headers.authorization, "Bearer t");
  }
});

/** A GraphQL page of a connection. */
const page = (nodes, endCursor) => ({
  pageInfo: { hasNextPage: endCursor !== undefined, endCursor },
  nodes,
});
const node = (id, state, extra = {}) => ({
  databaseId: id,
  author: { login: "reviewer" },
  state,
  body: `review ${id}`,
  submittedAt: "2026-11-11T00:00:00Z",
  commit: { oid: "c".repeat(40) },
  url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  ...extra,
});

test("every review of every pull request is exported with its decision", async () => {
  const bodies = [];
  const graphql = (body) => {
    bodies.push(body);
    const { after, number } = body.variables;
    if (body.query === MORE_REVIEWS)
      return {
        data: {
          repository: { pullRequest: { reviews: page([node(4, "APPROVED")]) } },
        },
      };
    const pulls =
      after === null
        ? page(
            [
              {
                number: 1,
                reviews: page(
                  [node(1, "CHANGES_REQUESTED"), node(2, "COMMENTED")],
                  "r1",
                ),
              },
            ],
            "p1",
          )
        : page([
            {
              number: 7,
              reviews: page([
                node(3, "APPROVED", { author: null, commit: null }),
              ]),
            },
          ]);
    assert.equal(number, undefined);
    return { data: { repository: { pullRequests: pulls } } };
  };
  const { directory, done } = run({ issues: [[{ number: 1 }]] }, { graphql });
  assert.equal((await done).reviews, 4);
  const written = readFileSync(join(directory, "reviews.ndjson"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    written.map(({ pull_request, id, state }) => [pull_request, id, state]),
    [
      [1, 1, "CHANGES_REQUESTED"],
      [1, 2, "COMMENTED"],
      [1, 4, "APPROVED"],
      [7, 3, "APPROVED"],
    ],
  );
  assert.deepEqual(written[0], {
    pull_request: 1,
    id: 1,
    user: "reviewer",
    state: "CHANGES_REQUESTED",
    body: "review 1",
    submitted_at: "2026-11-11T00:00:00Z",
    commit_id: "c".repeat(40),
    html_url: "https://github.com/o/r/pull/1#pullrequestreview-1",
  });
  // A deleted account or a review without a commit is still kept.
  assert.equal(written[3].user, null);
  assert.equal(written[3].commit_id, null);
  // Pull requests a hundred at a time, oldest first; a pull request with
  // more reviews than one page is read on from its own cursor.
  assert.deepEqual(
    bodies.map(({ query, variables }) => [query === PULL_REVIEWS, variables]),
    [
      [true, { owner: "o", name: "r", after: null }],
      [false, { owner: "o", name: "r", number: 1, after: "r1" }],
      [true, { owner: "o", name: "r", after: "p1" }],
    ],
  );
  assert.match(
    PULL_REVIEWS,
    /pullRequests\(first: 100, after: \$after, orderBy: \{field: CREATED_AT, direction: ASC\}\)/,
  );
});

test("a refused GraphQL query fails the export without echoing it", async () => {
  const graphql = () => ({
    data: null,
    errors: [{ message: "secret detail" }],
  });
  const list = async () => {
    for await (const _ of reviews("o/r", "t", api({}, { graphql })));
  };
  await assert.rejects(list, /^Error: GraphQL refused$/);
  const { directory, done } = run({ issues: [[{ number: 1 }]] }, { graphql });
  await assert.rejects(done, /GraphQL refused/);
  assert.equal(readdirSync(directory).includes("manifest.json"), false);
});

test("an empty, refused or misdirected export fails instead of being kept", async () => {
  await assert.rejects(
    run({ issues: [[]] }).done,
    /no issues or pull requests/,
  );
  const refused = run({}, { status: 403 });
  await assert.rejects(refused.done, /^Error: HTTP 403$/);
  assert.equal(readdirSync(refused.directory).includes("manifest.json"), false);
  await assert.rejects(
    exportRecords({
      repository: "not a repository",
      token: "t",
      directory: work,
    }),
    /owner\/name/,
  );
  // A link that leaves the API is refused before the token is sent to it.
  const calls = [];
  const elsewhere = async (url) => {
    calls.push(url);
    return {
      ok: true,
      headers: new Headers({
        link: '<https://elsewhere.example/next>; rel="next"',
      }),
      json: async () => [{ number: 1 }],
    };
  };
  const read = async () => {
    for await (const _ of records(`${BASE}/issues`, "t", elsewhere));
  };
  await assert.rejects(read, /not a GitHub API address/);
  assert.deepEqual(calls, [`${BASE}/issues`]);
});

test("the scheduled job exports, proves a fresh clone, then keeps the records", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["repository-records"];
  assert.deepEqual(job.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  const runs = job.steps.map((step) => String(step.run ?? step.uses));
  const at = (pattern) => runs.findIndex((text) => pattern.test(text));
  const exported = at(/repository-records\.mjs export/);
  const cloned = at(/git clone --mirror/);
  const uploaded = at(/^actions\/upload-artifact@[a-f0-9]{40}$/);
  assert.ok(exported >= 0 && cloned > exported && uploaded > cloned);
  // The clone is checked whole, and must hold the commit this run is for.
  assert.match(runs[cloned], /fsck --no-dangling/);
  assert.match(runs[cloned], /merge-base --is-ancestor "\$GITHUB_SHA"/);
  assert.deepEqual(job.steps[exported].env, {
    GH_TOKEN: "${{ github.token }}",
  });
  assert.equal(job.steps[uploaded].with.name, "repository-records");
  assert.equal(job.steps[uploaded].with["retention-days"], 90);
  assert.equal(job.steps[uploaded].with["if-no-files-found"], "error");
  for (const step of job.steps)
    assert.equal(step["continue-on-error"], undefined);
});
