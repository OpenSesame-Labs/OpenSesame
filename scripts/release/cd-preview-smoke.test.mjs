import assert from "node:assert/strict";
import {
  cacheBustOf,
  distTags,
  jsonResponse,
  manualClock,
  packumentDoc,
  registryReadKind,
  test,
  version,
  versionDoc,
} from "./cd-preview-smoke.fixtures.mjs";
import {
  CLI_PACKAGE,
  DEFAULT_REGISTRY_DEADLINE_MS,
  DEFAULT_REGISTRY_POLL_MS,
  assertExpectedVersion,
  assertVersionOutput,
  distTagVersion,
  exactPublishedVersionUrl,
  outputHasVersion,
  pollUntilDeadline,
  registryPollNonceToken,
  runPreviewSmoke,
  waitForPublishedVersion,
} from "./cd-preview-smoke.mjs";

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
      const kind = registryReadKind(url);
      if (kind === "packument") return packumentDoc(version);
      if (kind === "dist-tags") return distTags();
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
      const href = String(url);
      const kind = registryReadKind(href);
      if (kind === "packument") return packumentDoc(version);
      if (kind === "dist-tags") return distTags();
      queries.push(cacheBustOf(href));
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

test("waitForPublishedVersion polls until the packument lists the version", async () => {
  const clock = manualClock();
  const kinds = [];
  const slept = [];
  let packumentReads = 0;
  const seen = await waitForPublishedVersion(version, {
    now: clock.now,
    deadlineMs: 5_000,
    pollMs: 2_500,
    sleep: async (ms) => {
      slept.push(ms);
      await clock.sleep(ms);
    },
    fetch: async (url) => {
      const kind = registryReadKind(url);
      kinds.push(kind);
      if (kind === "version") return versionDoc(version);
      if (kind === "packument") {
        packumentReads += 1;
        if (packumentReads < 3) {
          return jsonResponse(200, {
            versions: { "0.0.0-alpha.0": { version: "0.0.0-alpha.0" } },
          });
        }
        return packumentDoc(version);
      }
      return distTags();
    },
  });
  assert.equal(seen, version);
  assert.equal(packumentReads, 3);
  assert.deepEqual(slept, [2_500, 2_500]);
  assert.equal(clock.now(), 5_000);
  assert.deepEqual(kinds, [
    "version",
    "packument",
    "version",
    "packument",
    "version",
    "packument",
    "dist-tags",
  ]);
});

test("waitForPublishedVersion polls until a dist-tag lists the version", async () => {
  const clock = manualClock();
  const slept = [];
  let tagReads = 0;
  const seen = await waitForPublishedVersion(version, {
    now: clock.now,
    deadlineMs: 5_000,
    pollMs: 2_500,
    sleep: async (ms) => {
      slept.push(ms);
      await clock.sleep(ms);
    },
    fetch: async (url) => {
      const kind = registryReadKind(url);
      if (kind === "version") return versionDoc(version);
      if (kind === "packument") return packumentDoc(version);
      tagReads += 1;
      if (tagReads < 3) {
        return jsonResponse(200, {
          latest: "1.2.3",
          alpha: "0.0.0-alpha.0",
          next: "0.0.0-next.1",
        });
      }
      return jsonResponse(200, { latest: "1.2.3", next: version });
    },
  });
  assert.equal(seen, version);
  assert.equal(tagReads, 3);
  assert.deepEqual(slept, [2_500, 2_500]);
  assert.equal(clock.now(), 5_000);
});

test("waitForPublishedVersion succeeds when version, packument, and dist-tags agree", async () => {
  const urls = [];
  const seen = await waitForPublishedVersion(version, {
    fetch: async (url) => {
      const href = String(url);
      urls.push(href);
      const kind = registryReadKind(href);
      if (kind === "version") return versionDoc(version);
      if (kind === "packument") return packumentDoc(version);
      return distTags();
    },
    sleep: async () => {
      throw new Error("sleep");
    },
    deadlineMs: 0,
    pollMs: DEFAULT_REGISTRY_POLL_MS,
  });
  assert.equal(seen, version);
  assert.equal(urls.length, 3);
  assert.match(
    urls[0],
    /@opensesame-labs%2fcli\/0\.0\.0-alpha\.4\?_cd_wait=[0-9a-z]+-[0-9a-z]+$/u,
  );
  assert.match(
    urls[1],
    /@opensesame-labs%2fcli\?_cd_wait=[0-9a-z]+-[0-9a-z]+$/u,
  );
  assert.match(
    urls[2],
    /\/-\/package\/@opensesame-labs%2fcli\/dist-tags\?_cd_wait=[0-9a-z]+-[0-9a-z]+$/u,
  );
  assert.equal(new Set(urls.map(cacheBustOf)).size, 3);
});
