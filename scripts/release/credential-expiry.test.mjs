import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  MAX_LIFETIME_DAYS,
  ROTATE_WITHIN_DAYS,
  assess,
  inspect,
  parseExpiry,
  tokenKind,
} from "./credential-expiry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/release/credential-expiry.mjs");
const now = new Date("2026-11-11T00:00:00Z");
const inDays = (days) =>
  `${new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ")} UTC`;

test("the kind is read from the public prefix only", () => {
  assert.equal(tokenKind("ghs_abc"), "app");
  assert.equal(tokenKind("github_pat_abc"), "fine-grained");
  assert.equal(tokenKind("ghp_abc"), "classic");
  assert.equal(tokenKind("something-else"), "unknown");
});

test("both documented header forms are read, and anything else is not guessed", () => {
  assert.equal(
    parseExpiry("2026-12-31 08:00:00 UTC").toISOString(),
    "2026-12-31T08:00:00.000Z",
  );
  assert.equal(
    parseExpiry("2026-12-31 08:00:00 -0500").toISOString(),
    "2026-12-31T13:00:00.000Z",
  );
  for (const value of [
    undefined,
    "",
    "soon",
    "2026-12-31",
    "2026-13-45 99:00:00 UTC",
  ])
    assert.equal(parseExpiry(value), undefined);
});

test("a credential that never expires, expires soon or lives too long is a warning", () => {
  const level = (kind, header) => assess({ kind, header, now }).level;
  assert.equal(level("app", null), "notice");
  assert.equal(level("classic", null), "warning");
  assert.equal(level("fine-grained", null), "warning");
  assert.equal(level("fine-grained", "unreadable"), "warning");
  assert.equal(level("fine-grained", inDays(ROTATE_WITHIN_DAYS)), "warning");
  assert.equal(level("fine-grained", inDays(ROTATE_WITHIN_DAYS + 1)), "notice");
  assert.equal(level("fine-grained", inDays(MAX_LIFETIME_DAYS)), "notice");
  assert.equal(level("fine-grained", inDays(MAX_LIFETIME_DAYS + 1)), "warning");
  assert.match(
    assess({ kind: "fine-grained", header: inDays(30), now }).message,
    /expires on 2026-12-11, in 30 days\.$/,
  );
});

test("the check sends the credential only as a bearer header and never reports it", async () => {
  const calls = [];
  const token = "github_pat_SECRETVALUE";
  const answer = (response) => async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  const found = await inspect({
    token,
    repository: "owner/name",
    now,
    fetcher: answer({
      ok: true,
      headers: new Headers({
        "github-authentication-token-expiration": inDays(40),
      }),
    }),
  });
  assert.equal(found.level, "notice");
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/name");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  const refused = await inspect({
    token,
    repository: "owner/name",
    now,
    fetcher: answer({ ok: false, status: 401, headers: new Headers() }),
  });
  // An expired or revoked credential fails here, with the reason, rather
  // than at the first step that uses it.
  assert.deepEqual(refused, {
    level: "error",
    message:
      "GitHub refused the release credential (HTTP 401): it has expired or been revoked. Replace it before releasing.",
  });
  const unavailable = await inspect({
    token,
    repository: "owner/name",
    now,
    fetcher: answer({ ok: false, status: 503, headers: new Headers() }),
  });
  assert.deepEqual(unavailable, {
    level: "warning",
    message: "The release credential could not be checked: HTTP 503.",
  });
  // The request gives up rather than stalling the release step.
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const offline = await inspect({
    token,
    repository: "owner/name",
    now,
    fetcher: async () => {
      throw new Error(`connect failed for ${token}`);
    },
  });
  assert.equal(offline.level, "warning");
  for (const result of [found, refused, unavailable, offline])
    assert.equal(JSON.stringify(result).includes("SECRETVALUE"), false);
});

test("an absent credential still fails the step, as the check it replaces did", () => {
  const run = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GH_TOKEN: "", GITHUB_REPOSITORY: "o/r" },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^::error title=Release credential::/);
});

test("the release stage runs it in the step that already held the credential", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/release-publish.yml"), "utf8"),
  );
  const step = workflow.jobs.stage.steps.find(
    (entry) => entry.name === "Require the protected publication credential",
  );
  assert.equal(
    step.run,
    "node .ci-control/scripts/release/credential-expiry.mjs",
  );
  assert.deepEqual(step.env, {
    GH_TOKEN: "${{ secrets.RELEASE_PUBLISH_TOKEN }}",
  });
  assert.equal(step["continue-on-error"], undefined);
});

test("every npm publish says which credential it uses", () => {
  const action = readFileSync(
    join(root, ".github/actions/publish-npm-package/action.yml"),
    "utf8",
  );
  const publish = parse(action).runs.steps.at(-1).run;
  const branches = publish.split(/^else$/m);
  assert.equal(branches.length, 2, "one token branch and one OIDC branch");
  assert.match(branches[0], /export NODE_AUTH_TOKEN=/);
  assert.match(branches[0], /::warning title=npm credential::/);
  assert.match(branches[1], /unset NODE_AUTH_TOKEN/);
  assert.match(branches[1], /::notice title=npm credential::/);
  // The messages are fixed text: no variable is expanded into them.
  for (const line of publish.split("\n").filter((l) => l.includes("::")))
    assert.equal(line.includes("$"), false, line);
});
