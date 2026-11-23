// Contract for scripts/security/ghcr-historical-cleanup.mjs and its job in
// .github/workflows/security.yml:
// only `next`/`latest` versions are deleted, never a package, an untagged or
// otherwise-tagged version, or a package's last version; any API error but a
// 404 on delete fails the run. Every call goes to an injected fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  PACKAGES,
  githubClient,
  nextLink,
  run,
  selectHistorical,
  summaryMarkdown,
} from "./ghcr-historical-cleanup.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const API = "https://api.github.com/orgs/OpenSesame-Labs/packages/container";

const version = (id, tags, created_at = "2026-01-01T00:00:00Z") => ({
  id,
  created_at,
  metadata: { container: { tags } },
});

/**
 * A fake registry: `pages` maps a package to its version pages; `deny` maps
 * "METHOD pkg" to an HTTP status. Records every call.
 */
function fakeRegistry({ pages = {}, deny = {}, gone = [] } = {}) {
  const calls = [];
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetch = async (url, init) => {
    calls.push({
      method: init.method,
      url: String(url),
      headers: init.headers,
    });
    const parsed = new URL(url);
    const [, pkg, , id] = parsed.pathname
      .slice("/orgs/OpenSesame-Labs/packages/container".length)
      .split("/");
    const denied = deny[`${init.method} ${pkg}`];
    if (denied) return json(denied, { message: "denied" });
    if (init.method === "GET") {
      const list = pages[pkg];
      if (!list) return json(404, { message: "Package not found." });
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const link =
        page < list.length
          ? {
              link: `<${API}/${pkg}/versions?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {};
      return json(200, list[page - 1], link);
    }
    if (init.method === "DELETE") {
      if (gone.includes(Number(id))) return json(404, { message: "gone" });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${init.method}`);
  };
  return { fetch, calls };
}

const quiet = () => {};
const deletes = (calls) =>
  calls.filter((call) => call.method === "DELETE").map((call) => call.url);

test("selects only versions tagged next or latest, each once", () => {
  const picked = selectHistorical([
    version(1, ["next", "latest"]),
    version(2, []),
    version(3, ["sha-abc"]),
    version(4, ["latest"]),
    version(5, ["next-ish", "v1.0.0"]),
    { id: 6 },
  ]);
  assert.deepEqual(
    picked.map((entry) => entry.id),
    [1, 4],
  );
});

test("dry-run lists every page and deletes nothing", async () => {
  const registry = fakeRegistry({
    pages: {
      cli: [
        [version(10, ["next"]), version(11, [])],
        [version(12, ["latest", "v0.1.0"]), version(13, ["sha-1"])],
      ],
    },
  });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "dry-run",
    packages: ["cli"],
    log: quiet,
  });
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(
    outcome.results[0].rows.map((row) => [row.id, row.action]),
    [
      [10, "would-delete"],
      [12, "would-delete"],
    ],
  );
  assert.equal(outcome.results[0].total, 4);
  assert.deepEqual(deletes(registry.calls), []);
  assert.equal(registry.calls.length, 2);
  assert.equal(registry.calls[0].headers.authorization, "Bearer t");
});

test("delete removes only the tagged versions and never the package", async () => {
  const registry = fakeRegistry({
    pages: {
      "web-pwa": [
        [
          version(20, ["next", "latest"]),
          version(21, []),
          version(22, ["sha-2"]),
        ],
      ],
    },
  });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "delete",
    packages: ["web-pwa"],
    log: quiet,
  });
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(deletes(registry.calls), [`${API}/web-pwa/versions/20`]);
  for (const call of registry.calls)
    assert.match(call.url, /\/versions(?:\/\d+)?(?:\?|$)/);
});

test("the last version of a package is skipped, not deleted", async () => {
  const registry = fakeRegistry({
    pages: {
      opensesame: [[version(30, ["latest"]), version(31, ["next"])]],
    },
  });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "delete",
    packages: ["opensesame"],
    log: quiet,
  });
  assert.deepEqual(
    outcome.results[0].rows.map((row) => [row.id, row.action]),
    [
      [30, "deleted"],
      [31, "skipped-last-version"],
    ],
  );
  assert.deepEqual(deletes(registry.calls), [`${API}/opensesame/versions/30`]);
  assert.match(
    summaryMarkdown(outcome),
    /skipped: last version of the package/,
  );
});

test("a delete that finds the version gone is not an error", async () => {
  const registry = fakeRegistry({
    pages: { cli: [[version(40, ["next"]), version(41, [])]] },
    gone: [40],
  });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "delete",
    packages: ["cli"],
    log: quiet,
  });
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.results[0].rows[0].action, "already-gone");
});

test("a 403 on delete fails with the missing admin access named", async () => {
  const registry = fakeRegistry({
    pages: {
      cli: [[version(50, ["next"]), version(51, [])]],
      "control-plane": [[version(60, ["latest"]), version(61, [])]],
    },
    deny: { "DELETE cli": 403 },
  });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "delete",
    packages: ["cli", "control-plane"],
    log: quiet,
  });
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /OpenSesame-Labs\/cli: HTTP 403/);
  assert.match(outcome.errors[0], /lacks admin access/);
  // The other package still ran.
  assert.deepEqual(deletes(registry.calls), [
    `${API}/cli/versions/50`,
    `${API}/control-plane/versions/60`,
  ]);
  assert.match(summaryMarkdown(outcome), /### Errors/);
});

test("a listing error fails, including a missing package", async () => {
  const registry = fakeRegistry({ deny: { "GET cli": 500 } });
  const client = githubClient({ token: "t", fetch: registry.fetch });
  const outcome = await run({
    client,
    mode: "dry-run",
    packages: ["cli", "web-pwa"],
    log: quiet,
  });
  assert.equal(outcome.errors.length, 2);
  assert.match(outcome.errors[0], /list OpenSesame-Labs\/cli: HTTP 500/);
  assert.match(outcome.errors[1], /HTTP 404, the package does not exist/);
});

test("refuses an unknown mode and a missing token", async () => {
  const client = githubClient({ token: "t", fetch: fakeRegistry().fetch });
  await assert.rejects(
    run({ client, mode: "purge", log: quiet }),
    /mode must be/,
  );
  assert.throws(() => githubClient({ token: "" }), /GH_TOKEN/);
});

test("reads the next page from a Link header", () => {
  assert.equal(
    nextLink(
      '<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"',
    ),
    "https://x/a?page=2",
  );
  assert.equal(nextLink('<https://x/a?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test("the packages are the published images security.yml scans", () => {
  const security = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = security.jobs["container-images"];
  const images = [
    ...new Set(job.strategy.matrix.target.map((row) => row.image)),
  ];
  assert.deepEqual([...PACKAGES].sort(), images.sort());
  assert.deepEqual(job.strategy.matrix.tag, ["next", "latest"]);
});

test("the cleanup job runs on dispatch only, before the scan, defaulting to dry-run", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const mode = workflow.on.workflow_dispatch.inputs.mode;
  assert.equal(mode.default, "dry-run");
  assert.deepEqual(mode.options, ["dry-run", "delete"]);
  assert.deepEqual(workflow.permissions, {});
  const job = workflow.jobs["historical-tags"];
  assert.equal(job.if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
  // No other job may write packages.
  for (const [name, other] of Object.entries(workflow.jobs))
    if (name !== "historical-tags")
      assert.notEqual(other.permissions?.packages, "write", name);
  const step = job.steps.find((entry) =>
    String(entry.run ?? "").includes("ghcr-historical-cleanup.mjs"),
  );
  // The sparse checkout carries every directory the script imports from, so
  // the job can load it (a missing scripts/lib once failed the first run).
  const checkout = job.steps.find((entry) =>
    String(entry.uses ?? "").startsWith("actions/checkout@"),
  );
  const checkedOut = String(checkout.with["sparse-checkout"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const source = readFileSync(
    join(root, "scripts/security/ghcr-historical-cleanup.mjs"),
    "utf8",
  );
  for (const [, specifier] of source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
    const path = join("scripts/security", specifier);
    assert.ok(
      checkedOut.some((dir) => path === dir || path.startsWith(`${dir}/`)),
      `${path} is outside the job's sparse checkout`,
    );
  }
  // The input reaches the script through env, never the script body.
  assert.equal(step.env.MODE, "${{ inputs.mode }}");
  assert.doesNotMatch(step.run, /\$\{\{/);
  // The scan waits for the cleanup but still runs when it is skipped.
  const scan = workflow.jobs["container-images"];
  assert.deepEqual(scan.needs, ["historical-tags"]);
  assert.equal(scan.if, "${{ !cancelled() }}");
});
