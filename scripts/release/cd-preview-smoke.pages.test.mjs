import assert from "node:assert/strict";
import {
  distTags,
  manualClock,
  oneRetry,
  oneShot,
  packumentDoc,
  page,
  pagesUrl,
  registryReadKind,
  sha,
  test,
  version,
  versionDoc,
  viewResult,
} from "./cd-preview-smoke.fixtures.mjs";
import {
  CLI_SPEC,
  WEB_PWA_PACKAGE,
  assertPagesRelease,
  assertPagesUrlLoads,
  runPreviewSmoke,
} from "./cd-preview-smoke.mjs";

test("pages URL must load over HTTPS and match the release sha", async () => {
  await assertPagesUrlLoads(pagesUrl, async () => page());
  await assert.rejects(
    () => assertPagesUrlLoads(pagesUrl, async () => page(503, "down")),
    /HTTP 503/,
  );
  await assert.rejects(
    () => assertPagesUrlLoads(pagesUrl, async () => page(200, "")),
    /empty body/,
  );
  await assert.rejects(
    () => assertPagesUrlLoads("http://example.com/", async () => page()),
    /clean HTTPS/,
  );
  let verified = "";
  await assertPagesRelease(pagesUrl, sha, async (url, revision) => {
    verified = `${url} ${revision}`;
  });
  assert.equal(verified, `${pagesUrl} ${sha}`);
  await assert.rejects(
    () => assertPagesRelease(pagesUrl, "abc", async () => {}),
    /GITHUB_SHA/,
  );
});

test("cd-pwa smoke GETs the pages URL and verifies the release", async () => {
  const seen = [];
  let verified = false;
  await runPreviewSmoke(
    { PAGES_URL: pagesUrl, GITHUB_SHA: sha, ...oneShot },
    {
      fetch: async (url) => {
        const href = String(url);
        seen.push(href);
        if (href.includes("dist-tags")) return distTags();
        assert.equal(href, pagesUrl);
        return page();
      },
      run: async (command) => {
        if (command === "npm") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: version, stderr: "" };
      },
      verifyPages: async (url, revision) => {
        verified = url === pagesUrl && revision === sha;
      },
    },
  );
  assert.equal(verified, true);
  assert.ok(seen.includes(pagesUrl));
});

test("pages checks retry on the registry deadline", async () => {
  const clock = manualClock();
  let pages = 0;
  let slept = 0;
  await runPreviewSmoke(
    {
      PAGES_URL: pagesUrl,
      GITHUB_SHA: sha,
      ...oneRetry,
    },
    {
      now: clock.now,
      sleep: async (ms) => {
        assert.equal(ms, 10_000);
        slept += 1;
        await clock.sleep(ms);
      },
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("dist-tags")) return distTags();
        pages += 1;
        if (pages === 1) return page(503, "down");
        return page();
      },
      run: async (command) => {
        if (command === "npm") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: version, stderr: "" };
      },
      verifyPages: async () => {},
    },
  );
  assert.equal(pages, 2);
  assert.equal(slept, 1);
});

test("PWA preview smoke waits for web-pwa before the CLI alpha install", async () => {
  const calls = [];
  const urls = [];
  const webVersion = "0.0.0-alpha.9";
  const seen = await runPreviewSmoke(
    {
      EXPECTED_VERSION: webVersion,
      SMOKE_PUBLISHED_PACKAGE: WEB_PWA_PACKAGE,
      PAGES_URL: pagesUrl,
      GITHUB_SHA: sha,
      ...oneShot,
    },
    {
      fetch: async (url) => {
        const href = String(url);
        urls.push(href);
        const kind = registryReadKind(href);
        if (kind === "version") return versionDoc(webVersion);
        if (kind === "packument") return packumentDoc(webVersion);
        if (kind === "dist-tags") {
          return href.includes("_cd_wait=")
            ? distTags(webVersion)
            : distTags(version);
        }
        return page();
      },
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
      verifyPages: async (url, revision) => {
        assert.equal(url, pagesUrl);
        assert.equal(revision, sha);
      },
    },
  );
  assert.equal(seen, version);
  assert.match(
    urls[0],
    /@opensesame-labs%2fweb-pwa\/0\.0\.0-alpha\.9\?_cd_wait=/u,
  );
  assert.match(urls[1], /@opensesame-labs%2fweb-pwa\?_cd_wait=/u);
  assert.match(
    urls[2],
    /\/-\/package\/@opensesame-labs%2fweb-pwa\/dist-tags\?_cd_wait=/u,
  );
  assert.ok(calls[0][1].includes(CLI_SPEC));
  assert.deepEqual(calls[1][1], ["--version"]);
  assert.match(urls[3], /\/-\/package\/@opensesame-labs%2fcli\/dist-tags$/u);
  assert.ok(urls.includes(pagesUrl));
});

test("PWA preview smoke does not install the CLI when web-pwa is missing", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runPreviewSmoke(
        {
          EXPECTED_VERSION: version,
          SMOKE_PUBLISHED_PACKAGE: WEB_PWA_PACKAGE,
          ...oneShot,
        },
        {
          fetch: async () => versionDoc("0.0.0-alpha.0"),
          run: async (command, args) => {
            calls.push([command, args]);
            return viewResult(`${version}\n`);
          },
        },
      ),
    /registry @opensesame-labs\/web-pwa@0\.0\.0-alpha\.4 version returned 0\.0\.0-alpha\.0/,
  );
  assert.equal(calls.length, 0);
});

test("SMOKE_PUBLISHED_PACKAGE rejects unknown names and requires a version", async () => {
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { SMOKE_PUBLISHED_PACKAGE: "@evil/cli", EXPECTED_VERSION: version },
        { fetch: async () => distTags() },
      ),
    /SMOKE_PUBLISHED_PACKAGE must be @opensesame-labs\/cli or @opensesame-labs\/web-pwa/,
  );
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { SMOKE_PUBLISHED_PACKAGE: WEB_PWA_PACKAGE },
        { fetch: async () => distTags() },
      ),
    /EXPECTED_VERSION is required when SMOKE_PUBLISHED_PACKAGE is set/,
  );
});
