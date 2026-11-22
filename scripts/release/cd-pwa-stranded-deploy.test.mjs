import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cdPwaPathFilters,
  evaluateStrandedDeploy,
  gitDiffNameOnly,
  pagesDeployBase,
  parseReleaseManifest,
  releaseJsonUrl,
  strandedDeployNeeded,
} from "./cd-pwa-stranded-deploy.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const manifest = {
  format: "opensesame-pages-release",
  version: 1,
  revision: shaA,
  sha256: {
    "index.html": "c".repeat(64),
    "os-runtime-config.json": "d".repeat(64),
  },
};

test("parseReleaseManifest accepts a valid live manifest", () => {
  assert.equal(parseReleaseManifest(JSON.stringify(manifest)), shaA);
});

test("parseReleaseManifest rejects unexpected format", () => {
  assert.throws(
    () =>
      parseReleaseManifest(
        JSON.stringify({ format: "other", version: 1, revision: shaA }),
      ),
    /unexpected format/,
  );
});

test("strandedDeployNeeded is false when live revision matches GITHUB_SHA", () => {
  assert.equal(
    strandedDeployNeeded({
      githubSha: shaA,
      deployedRevision: shaA,
      pathFilters: ["apps/pages/**"],
      gitRunner: () => {
        throw new Error("git should not run");
      },
    }),
    false,
  );
});

test("strandedDeployNeeded is true when PWA paths changed since live revision", () => {
  assert.equal(
    strandedDeployNeeded({
      githubSha: shaB,
      deployedRevision: shaA,
      pathFilters: ["apps/pages/**"],
      gitRunner: () => "apps/pages/foo.ts\n",
    }),
    true,
  );
});

test("strandedDeployNeeded is false when only non-PWA paths changed", () => {
  assert.equal(
    strandedDeployNeeded({
      githubSha: shaB,
      deployedRevision: shaA,
      pathFilters: ["apps/pages/**"],
      gitRunner: () => "",
    }),
    false,
  );
});

test("evaluateStrandedDeploy skips dispatch when this push already triggers cd-pwa", async () => {
  const result = await evaluateStrandedDeploy(
    {
      GITHUB_SHA: shaB,
      PAGES_CANONICAL_ORIGIN: "https://opensesame-labs.github.io",
      VITE_BASE: "/OpenSesame/",
      CD_PWA_STRANDED_DEPLOYED_REVISION: shaA,
      CD_PWA_STRANDED_DIFF_OUTPUT: "apps/pages/x.ts",
      GITHUB_EVENT_BEFORE: "c".repeat(40),
    },
    {
      pathFilters: ["apps/pages/**"],
      gitRunner: (args) =>
        args.includes(`${"c".repeat(40)}..${shaB}`) ? "apps/pages/x.ts" : "",
    },
  );
  assert.equal(result.status, "up-to-date");
  assert.equal(result.deployNeeded, false);
});

test("evaluateStrandedDeploy uses test hooks without network or git", async () => {
  const result = await evaluateStrandedDeploy(
    {
      GITHUB_SHA: shaB,
      PAGES_CANONICAL_ORIGIN: "https://opensesame-labs.github.io",
      CD_PWA_STRANDED_DEPLOYED_REVISION: shaA,
      CD_PWA_STRANDED_DIFF_OUTPUT: "apps/pages/x.ts",
    },
    { pathFilters: ["apps/pages/**"] },
  );
  assert.equal(result.status, "deploy-needed");
  assert.equal(result.deployNeeded, true);
});

test("releaseJsonUrl respects VITE_BASE under canonical origin", () => {
  const url = releaseJsonUrl(
    "https://opensesame-labs.github.io",
    "/OpenSesame/",
  );
  assert.equal(
    url.href,
    "https://opensesame-labs.github.io/OpenSesame/release.json",
  );
  assert.equal(
    pagesDeployBase("https://opensesame-labs.github.io", "/OpenSesame/").href,
    "https://opensesame-labs.github.io/OpenSesame/",
  );
});

test("cdPwaPathFilters includes apps/pages from cd-pwa.yml", () => {
  const filters = cdPwaPathFilters();
  assert.ok(filters.includes("apps/pages/**"));
});

test("gitDiffNameOnly passes cd-pwa path patterns to git", () => {
  const calls = [];
  gitDiffNameOnly(
    shaA,
    shaB,
    ["apps/pages/**", "packages/app-core/**"],
    (args) => {
      calls.push(args);
      return "packages/app-core/foo.ts";
    },
  );
  assert.deepEqual(calls[0].slice(0, 4), [
    "diff",
    "--name-only",
    `${shaA}..${shaB}`,
    "--",
  ]);
  assert.ok(calls[0].includes("apps/pages/**"));
});
