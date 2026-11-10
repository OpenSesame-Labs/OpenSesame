import assert from "node:assert/strict";
import {
  cacheBustOf,
  distTags,
  jsonResponse,
  manualClock,
  oneRetry,
  oneShot,
  packumentDoc,
  registryReadKind,
  test,
  version,
  versionDoc,
  viewResult,
} from "./cd-preview-smoke.fixtures.mjs";
import {
  CLI_SPEC,
  DEFAULT_REGISTRY_DEADLINE_MS,
  DEFAULT_REGISTRY_POLL_MS,
  runPreviewSmoke,
} from "./cd-preview-smoke.mjs";

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
        const kind = registryReadKind(url);
        if (kind === "version") return versionDoc(version);
        if (kind === "packument") return packumentDoc(version);
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
        const kind = registryReadKind(href);
        assert.equal(calls.length, 0);
        if (kind === "version") return versionDoc(version);
        if (kind === "packument") return packumentDoc(version);
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
  assert.match(urls[1], /@opensesame-labs%2fcli\?_cd_wait=/u);
  assert.match(urls[2], /dist-tags\?_cd_wait=/u);
  assert.match(urls[3], /\/dist-tags$/u);
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
        const href = String(url);
        const kind = registryReadKind(href);
        if (kind === "dist-tags") {
          assert.equal(polls, 2);
          distTagsFetched += 1;
          return distTags();
        }
        if (kind === "packument") return packumentDoc(version);
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
  assert.equal(distTagsFetched, 2);
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
        const kind = registryReadKind(url);
        if (kind === "version") {
          polls += 1;
          if (clock.now() < DEFAULT_REGISTRY_DEADLINE_MS) {
            return versionDoc("0.0.0-alpha.0");
          }
          return versionDoc(version);
        }
        if (kind === "packument") return packumentDoc(version);
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
            const href = String(url);
            urls.push(href);
            const kind = registryReadKind(href);
            if (kind === "version") return versionDoc("0.0.0-alpha.9");
            if (kind === "packument") return packumentDoc("0.0.0-alpha.9");
            if (kind === "dist-tags" && href.includes("_cd_wait=")) {
              return distTags("0.0.0-alpha.9");
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
  assert.match(urls[3], /\/dist-tags$/u);
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
        const kind = registryReadKind(url);
        if (kind === "version") return versionDoc(version);
        if (kind === "packument") return packumentDoc(version);
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
