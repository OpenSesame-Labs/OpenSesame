import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import {
  CLI_PACKAGE,
  CLI_SPEC,
  DEFAULT_REGISTRY_DEADLINE_MS,
  DEFAULT_REGISTRY_POLL_MS,
  WEB_PWA_PACKAGE,
  assertExpectedVersion,
  assertPagesRelease,
  assertPagesUrlLoads,
  assertVersionOutput,
  distTagVersion,
  exactPublishedVersionUrl,
  outputHasVersion,
  pollUntilDeadline,
  registryPollNonceToken,
  runPreviewSmoke,
  waitForPublishedVersion,
} from "./cd-preview-smoke.mjs";

// Vitest collects calls named test. test:ci-promotion runs this file with
// node:test, so load vitest only when that runner set VITEST.
const test = process.env.VITEST ? (await import("vitest")).test : nodeTest;

const version = "0.0.0-alpha.4";
const sha = "b".repeat(40);
const pagesUrl = "https://opensesame-labs.github.io/OpenSesame/";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body.length === undefined ? JSON.stringify(body) : body),
  };
}

function distTags(alpha = version) {
  return jsonResponse(200, { alpha });
}

function viewResult(stdout, status = 0) {
  return { status, stdout, stderr: "" };
}

function versionDoc(seen = version, status = 200) {
  return jsonResponse(status, { version: seen });
}

function cacheBustOf(url) {
  return new URL(String(url)).searchParams.get("_cd_wait");
}

function page(status = 200, body = "<!doctype html><title>OpenSesame</title>") {
  return jsonResponse(status, body);
}

function manualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

const oneShot = {
  SMOKE_REGISTRY_DEADLINE_MS: "0",
  SMOKE_REGISTRY_POLL_MS: "10000",
};

const oneRetry = {
  SMOKE_REGISTRY_DEADLINE_MS: "10000",
  SMOKE_REGISTRY_POLL_MS: "10000",
};

test("registry wait defaults are five minutes and 2.5 seconds", () => {
  assert.equal(DEFAULT_REGISTRY_DEADLINE_MS, 300_000);
  assert.equal(DEFAULT_REGISTRY_POLL_MS, 2_500);
});

test("pollUntilDeadline retries on the poll interval until the deadline", async () => {
  const clock = manualClock();
  let calls = 0;
  await assert.rejects(
    () =>
      pollUntilDeadline(
        30_000,
        10_000,
        clock.sleep,
        async () => {
          calls += 1;
          throw new Error("not yet");
        },
        clock.now,
      ),
    /not yet/,
  );
  assert.equal(calls, 4);
  assert.equal(clock.now(), 30_000);
});

test("preview smoke refuses intentional proof gate failure", async () => {
  await assert.rejects(
    runPreviewSmoke(
      { CD_PROOF_GATE_FAIL: "1" },
      {
        fetch: async () => {
          throw new Error("fetch");
        },
      },
    ),
    /intentional promotion gate proof failure/,
  );
});

test("dist-tag alpha must be a semver and match EXPECTED_VERSION", () => {
  assert.equal(distTagVersion({ alpha: version }), version);
  assert.throws(
    () => distTagVersion({ next: version }),
    /dist-tag alpha is missing/,
  );
  assert.throws(
    () => distTagVersion({ alpha: "latest" }),
    /dist-tag alpha is missing/,
  );
  assert.throws(
    () => assertExpectedVersion(version, "0.0.0-alpha.5"),
    /alpha 0\.0\.0-alpha\.4 != expected 0\.0\.0-alpha\.5/,
  );
  assertExpectedVersion(version, undefined);
});

test("opensesame --version must exit 0 and report the resolved version", () => {
  assert.equal(outputHasVersion(`${version}\n`, version), true);
  assert.equal(outputHasVersion(`opensesame ${version}`, version), true);
  assert.equal(outputHasVersion("0.0.0-alpha.40", "0.0.0-alpha.4"), false);
  assert.throws(() => assertVersionOutput(1, version, version), /exited 1/);
  assert.throws(
    () => assertVersionOutput(0, "0.0.0-alpha.9", version),
    /did not report 0\.0\.0-alpha\.4/,
  );
});

test("waitForPublishedVersion accepts only the exact version", async () => {
  const urls = [];
  const noSleep = async () => {
    throw new Error("sleep");
  };
  const seen = await waitForPublishedVersion(version, {
    fetch: async (url) => {
      urls.push(String(url));
      return versionDoc(version);
    },
    sleep: noSleep,
    deadlineMs: 0,
    pollMs: DEFAULT_REGISTRY_POLL_MS,
  });
  assert.equal(seen, version);
  assert.match(
    urls[0],
    /@opensesame-labs%2fcli\/0\.0\.0-alpha\.4\?_cd_wait=[0-9a-z]+-[0-9a-z]+$/u,
  );
  await assert.rejects(
    () =>
      waitForPublishedVersion(version, {
        fetch: async () => versionDoc("0.0.0-alpha.40"),
        sleep: noSleep,
        deadlineMs: 0,
        pollMs: DEFAULT_REGISTRY_POLL_MS,
      }),
    /returned 0\.0\.0-alpha\.40 != 0\.0\.0-alpha\.4/,
  );
  await assert.rejects(
    () =>
      waitForPublishedVersion(version, {
        fetch: async () => versionDoc("", 404),
        sleep: noSleep,
        deadlineMs: 0,
        pollMs: DEFAULT_REGISTRY_POLL_MS,
      }),
    /HTTP 404/,
  );
  await assert.rejects(
    () =>
      waitForPublishedVersion(version, {
        fetch: async () => versionDoc(`  ${version}`),
        sleep: noSleep,
        deadlineMs: 0,
        pollMs: DEFAULT_REGISTRY_POLL_MS,
      }),
    /!= 0\.0\.0-alpha\.4/,
  );
});

test("exact version polls use a fresh monotonic cache-bust query", async () => {
  const clock = manualClock();
  const queries = [];
  const before = registryPollNonceToken(0);
  await waitForPublishedVersion(version, {
    now: clock.now,
    deadlineMs: 5_000,
    pollMs: 2_500,
    sleep: async (ms) => {
      await clock.sleep(ms);
    },
    fetch: async (url) => {
      queries.push(cacheBustOf(url));
      if (queries.length < 3) return versionDoc("0.0.0-alpha.0");
      return versionDoc(version);
    },
  });
  assert.equal(queries.length, 3);
  const counters = [before, ...queries].map((query) =>
    Number.parseInt(query.split("-")[1], 36),
  );
  assert.ok(counters[1] > counters[0]);
  assert.ok(counters[2] > counters[1]);
  assert.ok(counters[3] > counters[2]);
  assert.equal(
    exactPublishedVersionUrl(CLI_PACKAGE, version, queries[0]),
    `https://registry.npmjs.org/@opensesame-labs%2fcli/${version}?_cd_wait=${queries[0]}`,
  );
});

test("confirmed registry version skips npm view and still installs", async () => {
  const calls = [];
  const versionSeen = await runPreviewSmoke(
    {
      EXPECTED_VERSION: version,
      CD_REGISTRY_VERSION_CONFIRMED: "1",
      ...oneShot,
    },
    {
      fetch: async (url) => {
        assert.match(String(url), /dist-tags/);
        return distTags();
      },
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm" && args[0] === "view") {
          throw new Error("view");
        }
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(versionSeen, version);
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) => call[1][0] === "view"),
    false,
  );
  assert.ok(calls[0][1].includes(CLI_SPEC));
  assert.deepEqual(calls[1][1], ["--version"]);
  assert.match(calls[1][0], /opensesame$/u);
});

test("confirmed registry version still requires the alpha dist-tag", async () => {
  await assert.rejects(
    () =>
      runPreviewSmoke(
        {
          EXPECTED_VERSION: version,
          CD_REGISTRY_VERSION_CONFIRMED: "1",
          ...oneShot,
        },
        {
          fetch: async () => distTags("0.0.0-alpha.0"),
          run: async () => viewResult(""),
        },
      ),
    /alpha 0\.0\.0-alpha\.0 != expected 0\.0\.0-alpha\.4/,
  );
});

test("registry confirmation other than 1 still waits for the exact version", async () => {
  const calls = [];
  const urls = [];
  await runPreviewSmoke(
    {
      EXPECTED_VERSION: version,
      CD_REGISTRY_VERSION_CONFIRMED: "yes",
      ...oneShot,
    },
    {
      fetch: async (url) => {
        urls.push(String(url));
        if (String(url).includes("_cd_wait=")) return versionDoc(version);
        return distTags();
      },
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.match(urls[0], /_cd_wait=/u);
  assert.equal(calls[0][1][0], "install");
});

test("preview smoke GETs the exact version before dist-tags", async () => {
  const calls = [];
  const urls = [];
  const versionSeen = await runPreviewSmoke(
    { EXPECTED_VERSION: version, ...oneShot },
    {
      fetch: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("_cd_wait=")) {
          assert.equal(calls.length, 0);
          return versionDoc(version);
        }
        assert.match(href, /@opensesame-labs%2fcli\/dist-tags/);
        return distTags();
      },
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(versionSeen, version);
  assert.match(urls[0], /\/0\.0\.0-alpha\.4\?_cd_wait=/u);
  assert.match(urls[1], /dist-tags/);
  assert.equal(calls.length, 2);
  assert.ok(calls[0][1].includes(CLI_SPEC));
  assert.deepEqual(calls[1][1], ["--version"]);
  assert.match(calls[1][0], /opensesame$/u);
});

test("preview smoke does not accept a wrong registry version", async () => {
  let distTagsFetched = 0;
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: version, ...oneShot },
        {
          fetch: async (url) => {
            if (String(url).includes("dist-tags")) {
              distTagsFetched += 1;
              return distTags();
            }
            return versionDoc("0.0.0-alpha.0");
          },
          run: async () => {
            throw new Error("npm");
          },
        },
      ),
    /returned 0\.0\.0-alpha\.0 != 0\.0\.0-alpha\.4/,
  );
  assert.equal(distTagsFetched, 0);
});

test("preview smoke fails when registry propagation does not catch up", async () => {
  const clock = manualClock();
  let polls = 0;
  const queries = [];
  let distTagsFetched = 0;
  const slept = [];
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: version, ...oneRetry },
        {
          now: clock.now,
          fetch: async (url) => {
            const href = String(url);
            if (href.includes("dist-tags")) {
              distTagsFetched += 1;
              return distTags();
            }
            polls += 1;
            queries.push(cacheBustOf(href));
            return versionDoc("0.0.0-alpha.0");
          },
          sleep: async (ms) => {
            slept.push(ms);
            await clock.sleep(ms);
          },
          run: async () => {
            throw new Error("npm");
          },
        },
      ),
    /returned 0\.0\.0-alpha\.0 != 0\.0\.0-alpha\.4/,
  );
  assert.equal(polls, 2);
  assert.notEqual(queries[0], queries[1]);
  assert.deepEqual(slept, [10_000]);
  assert.equal(distTagsFetched, 0);
});

test("preview smoke retries the exact version then fetches dist-tags", async () => {
  const clock = manualClock();
  let polls = 0;
  let distTagsFetched = 0;
  await runPreviewSmoke(
    { EXPECTED_VERSION: version, ...oneRetry },
    {
      now: clock.now,
      fetch: async (url) => {
        if (String(url).includes("dist-tags")) {
          assert.equal(polls, 2);
          distTagsFetched += 1;
          return distTags();
        }
        polls += 1;
        if (polls === 1) return versionDoc("0.0.0-alpha.0");
        return versionDoc(version);
      },
      sleep: async (ms) => {
        assert.equal(ms, 10_000);
        await clock.sleep(ms);
      },
      run: async (command) => {
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(distTagsFetched, 1);
});

test("unset smoke env polls for five minutes at 2.5 second intervals", async () => {
  const clock = manualClock();
  let polls = 0;
  const slept = [];
  await runPreviewSmoke(
    { EXPECTED_VERSION: version },
    {
      now: clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        await clock.sleep(ms);
      },
      fetch: async (url) => {
        if (String(url).includes("_cd_wait=")) {
          polls += 1;
          if (clock.now() < DEFAULT_REGISTRY_DEADLINE_MS) {
            return versionDoc("0.0.0-alpha.0");
          }
          return versionDoc(version);
        }
        return distTags();
      },
      run: async (command) => {
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  const attempts =
    Math.floor(DEFAULT_REGISTRY_DEADLINE_MS / DEFAULT_REGISTRY_POLL_MS) + 1;
  assert.equal(polls, attempts);
  assert.equal(slept.length, attempts - 1);
  assert.ok(slept.every((ms) => ms === DEFAULT_REGISTRY_POLL_MS));
});

test("preview smoke refuses an alpha version other than EXPECTED_VERSION", async () => {
  const calls = [];
  const urls = [];
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: "0.0.0-alpha.9", ...oneShot },
        {
          fetch: async (url) => {
            urls.push(String(url));
            if (String(url).includes("_cd_wait=")) {
              return versionDoc("0.0.0-alpha.9");
            }
            return distTags();
          },
          run: async (command, args) => {
            calls.push([command, args]);
            return viewResult(version);
          },
        },
      ),
    /alpha 0\.0\.0-alpha\.4 != expected 0\.0\.0-alpha\.9/,
  );
  assert.equal(calls.length, 0);
  assert.match(urls[0], /@opensesame-labs%2fcli\/0\.0\.0-alpha\.9\?_cd_wait=/u);
  assert.match(urls[1], /dist-tags/);
});

test("preview smoke retries a missing package then accepts it", async () => {
  const clock = manualClock();
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    if (fetches === 1) return jsonResponse(404, {});
    return distTags();
  };
  let slept = 0;
  await runPreviewSmoke(
    { ...oneRetry },
    {
      now: clock.now,
      fetch: fetcher,
      sleep: async (ms) => {
        assert.equal(ms, 10_000);
        slept += 1;
        await clock.sleep(ms);
      },
      run: async (command) => {
        if (command === "npm") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: version, stderr: "" };
      },
    },
  );
  assert.equal(fetches, 2);
  assert.equal(slept, 1);
});

test("install and version retries use the registry deadline", async () => {
  const clock = manualClock();
  let installs = 0;
  await runPreviewSmoke(
    { EXPECTED_VERSION: version, ...oneRetry },
    {
      now: clock.now,
      sleep: async (ms) => {
        assert.equal(ms, 10_000);
        await clock.sleep(ms);
      },
      fetch: async (url) => {
        if (String(url).includes("_cd_wait=")) return versionDoc(version);
        return distTags();
      },
      run: async (command) => {
        if (command === "npm") {
          installs += 1;
          if (installs === 1) return { status: 1, stdout: "", stderr: "nope" };
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: `${version}\n`, stderr: "" };
      },
    },
  );
  assert.equal(installs, 2);
});

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
        if (href.includes("_cd_wait=")) return versionDoc(webVersion);
        if (href.includes("dist-tags")) return distTags(version);
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
  assert.ok(calls[0][1].includes(CLI_SPEC));
  assert.deepEqual(calls[1][1], ["--version"]);
  assert.match(urls[1], /dist-tags/);
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
