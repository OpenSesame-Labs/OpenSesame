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
  outputHasVersion,
  pollUntilDeadline,
  runPreviewSmoke,
  viewPublishedVersionArgs,
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

const viewArgs = viewPublishedVersionArgs(CLI_PACKAGE, version);

function viewResult(stdout, status = 0) {
  return { status, stdout, stderr: "" };
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

test("registry wait defaults are five minutes and ten seconds", () => {
  assert.equal(DEFAULT_REGISTRY_DEADLINE_MS, 300_000);
  assert.equal(DEFAULT_REGISTRY_POLL_MS, 10_000);
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

test("waitForPublishedVersion accepts only the exact trimmed version", async () => {
  const calls = [];
  const seen = await waitForPublishedVersion(
    version,
    async (command, args) => {
      calls.push([command, args]);
      return viewResult(`  ${version}\n`);
    },
    {
      sleep: async () => {
        throw new Error("sleep");
      },
      deadlineMs: 0,
      pollMs: DEFAULT_REGISTRY_POLL_MS,
    },
  );
  assert.equal(seen, version);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1], viewArgs);
  await assert.rejects(
    () =>
      waitForPublishedVersion(
        version,
        async () => viewResult("0.0.0-alpha.40\n"),
        {
          sleep: async () => {
            throw new Error("sleep");
          },
          deadlineMs: 0,
          pollMs: DEFAULT_REGISTRY_POLL_MS,
        },
      ),
    /returned 0\.0\.0-alpha\.40 != 0\.0\.0-alpha\.4/,
  );
  await assert.rejects(
    () =>
      waitForPublishedVersion(version, async () => viewResult("", 1), {
        sleep: async () => {
          throw new Error("sleep");
        },
        deadlineMs: 0,
        pollMs: DEFAULT_REGISTRY_POLL_MS,
      }),
    /exited 1/,
  );
});

test("preview smoke calls npm view --prefer-online before dist-tags", async () => {
  const calls = [];
  let fetched = false;
  const fetcher = async (url) => {
    assert.equal(
      calls.some((call) => call[1][0] === "view"),
      true,
    );
    fetched = true;
    assert.match(String(url), /@opensesame-labs%2fcli\/dist-tags/);
    return distTags();
  };
  const versionSeen = await runPreviewSmoke(
    { EXPECTED_VERSION: version, ...oneShot },
    {
      fetch: fetcher,
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm" && args[0] === "view") {
          assert.equal(fetched, false);
          return viewResult(`${version}\n`);
        }
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(versionSeen, version);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1], viewArgs);
  assert.ok(calls[1][1].includes(CLI_SPEC));
  assert.deepEqual(calls[2][1], ["--version"]);
  assert.match(calls[2][0], /opensesame$/u);
});

test("preview smoke does not accept a wrong npm view version", async () => {
  let fetches = 0;
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: version, ...oneShot },
        {
          fetch: async () => {
            fetches += 1;
            return distTags();
          },
          run: async (command, args) => {
            assert.equal(command, "npm");
            assert.equal(args[0], "view");
            return viewResult("0.0.0-alpha.0\n");
          },
        },
      ),
    /returned 0\.0\.0-alpha\.0 != 0\.0\.0-alpha\.4/,
  );
  assert.equal(fetches, 0);
});

test("preview smoke fails when registry propagation does not catch up", async () => {
  const clock = manualClock();
  let views = 0;
  let fetches = 0;
  const slept = [];
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: version, ...oneRetry },
        {
          now: clock.now,
          fetch: async () => {
            fetches += 1;
            return distTags();
          },
          sleep: async (ms) => {
            slept.push(ms);
            await clock.sleep(ms);
          },
          run: async (command, args) => {
            assert.equal(command, "npm");
            assert.deepEqual(args, viewArgs);
            views += 1;
            return viewResult("0.0.0-alpha.0\n");
          },
        },
      ),
    /returned 0\.0\.0-alpha\.0 != 0\.0\.0-alpha\.4/,
  );
  assert.equal(views, 2);
  assert.deepEqual(slept, [10_000]);
  assert.equal(fetches, 0);
});

test("preview smoke retries npm view then fetches dist-tags", async () => {
  const clock = manualClock();
  let views = 0;
  let fetches = 0;
  await runPreviewSmoke(
    { EXPECTED_VERSION: version, ...oneRetry },
    {
      now: clock.now,
      fetch: async () => {
        assert.equal(views, 2);
        fetches += 1;
        return distTags();
      },
      sleep: async (ms) => {
        assert.equal(ms, 10_000);
        await clock.sleep(ms);
      },
      run: async (command, args) => {
        if (command === "npm" && args[0] === "view") {
          views += 1;
          if (views === 1) return viewResult("0.0.0-alpha.0\n");
          return viewResult(`${version}\n`);
        }
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(fetches, 1);
});

test("unset smoke env polls for five minutes at ten second intervals", async () => {
  const clock = manualClock();
  let views = 0;
  const slept = [];
  await runPreviewSmoke(
    { EXPECTED_VERSION: version },
    {
      now: clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        await clock.sleep(ms);
      },
      fetch: async () => distTags(),
      run: async (command, args) => {
        if (args[0] === "view") {
          views += 1;
          if (clock.now() < DEFAULT_REGISTRY_DEADLINE_MS) {
            return viewResult("0.0.0-alpha.0\n");
          }
          return viewResult(`${version}\n`);
        }
        if (command === "npm") return viewResult("");
        return viewResult(`${version}\n`);
      },
    },
  );
  assert.equal(views, 31);
  assert.equal(slept.length, 30);
  assert.ok(slept.every((ms) => ms === DEFAULT_REGISTRY_POLL_MS));
});

test("preview smoke refuses an alpha version other than EXPECTED_VERSION", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { EXPECTED_VERSION: "0.0.0-alpha.9", ...oneShot },
        {
          fetch: async () => distTags(),
          run: async (command, args) => {
            calls.push([command, args]);
            if (args[0] === "view") {
              return viewResult("0.0.0-alpha.9\n");
            }
            return viewResult(version);
          },
        },
      ),
    /alpha 0\.0\.0-alpha\.4 != expected 0\.0\.0-alpha\.9/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], "view");
  assert.equal(calls[0][1][1], `${CLI_PACKAGE}@0.0.0-alpha.9`);
  assert.ok(calls[0][1].includes("--prefer-online"));
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
      fetch: async () => distTags(),
      run: async (command, args) => {
        if (args[0] === "view") return viewResult(`${version}\n`);
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
        urls.push(String(url));
        if (String(url).includes("dist-tags")) return distTags(version);
        return page();
      },
      sleep: async () => {
        throw new Error("sleep");
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm" && args[0] === "view") {
          return viewResult(`${webVersion}\n`);
        }
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
  assert.deepEqual(
    calls[0][1],
    viewPublishedVersionArgs(WEB_PWA_PACKAGE, webVersion),
  );
  assert.ok(calls[0][1].includes("--prefer-online"));
  assert.ok(calls[1][1].includes(CLI_SPEC));
  assert.deepEqual(calls[2][1], ["--version"]);
  assert.match(urls[0], /dist-tags/);
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
          fetch: async () => distTags(),
          run: async (command, args) => {
            calls.push([command, args]);
            return viewResult("0.0.0-alpha.0\n");
          },
        },
      ),
    /npm view @opensesame-labs\/web-pwa@0\.0\.0-alpha\.4 version returned 0\.0\.0-alpha\.0/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], "view");
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
