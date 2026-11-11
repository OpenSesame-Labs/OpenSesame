import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  LISTS,
  exportRecords,
  nextLink,
  records,
} from "./repository-records.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "opensesame-records-"));
after(() => rmSync(work, { recursive: true, force: true }));
const BASE = "https://api.github.com/repos/o/r";

/** A fake API: each list is an array of pages, linked the way GitHub links. */
function api(lists, { status } = {}) {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    if (status) return { ok: false, status };
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
  });
  assert.deepEqual(readdirSync(directory).sort(), [
    "issue-comments.ndjson",
    "issues.ndjson",
    "manifest.json",
    "review-comments.ndjson",
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
      counts: { issues: 3, "issue-comments": 1, "review-comments": 0 },
    },
  );
  // All issues and pull requests, open and closed, oldest first.
  assert.match(
    fetcher.seen[0].url,
    /\/issues\?state=all&per_page=100&sort=created&direction=asc$/,
  );
  for (const { url, init } of fetcher.seen) {
    assert.equal(url.startsWith(`${BASE}/`), true);
    assert.equal(init.headers.authorization, "Bearer t");
  }
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
