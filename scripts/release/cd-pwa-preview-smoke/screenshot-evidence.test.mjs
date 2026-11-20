import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureLiveSmokeEvidence,
  pushDiagnostic,
  smokeBrowserEntryUrl,
} from "./screenshot-evidence.mjs";

const sha = "a".repeat(40);

test("smokeBrowserEntryUrl matches pages.hurl index release query", () => {
  const hurl = readFileSync(new URL("./pages.hurl", import.meta.url), "utf8");
  assert.match(hurl, /index\.html\?release=\{\{github_sha\}\}/);
  const url = new URL(
    smokeBrowserEntryUrl("https://opensesame-labs.github.io/OpenSesame", sha),
  );
  assert.equal(url.origin, "https://opensesame-labs.github.io");
  assert.equal(url.pathname, "/OpenSesame/index.html");
  assert.equal(url.searchParams.get("release"), sha);
  assert.equal(
    url.href,
    `https://opensesame-labs.github.io/OpenSesame/index.html?release=${sha}`,
  );
});

test("captureLiveSmokeEvidence requires evidence output directory", async () => {
  await assert.rejects(
    () =>
      captureLiveSmokeEvidence({
        PAGES_URL: "https://example.github.io/OpenSesame/",
        GITHUB_SHA: sha,
      }),
    /SMOKE_EVIDENCE_OUT is required/,
  );
});

function fakeBrowser(counts) {
  const events = [];
  const page = {
    async goto(url, opts) {
      events.push({ op: "goto", url, opts });
    },
    getByRole(role, query = {}) {
      const name = query.name;
      return {
        async waitFor(opts) {
          events.push({
            op: "wait",
            role,
            name,
            level: query.level,
            opts,
          });
        },
        async count() {
          events.push({ op: "count", role, name });
          if (name === "Continue as guest") return counts.guest;
          if (name === "Full") return counts.full;
          return 1;
        },
        async click() {
          events.push({ op: "click", role, name });
        },
      };
    },
    getByText(text) {
      return {
        async count() {
          events.push({ op: "text", text });
          return text === "Use without an account" ? counts.withoutAccount : 0;
        },
      };
    },
    async screenshot(shot) {
      events.push({ op: "shot", path: shot.path });
      await writeFile(shot.path, "png");
    },
  };
  return {
    events,
    launchHeadlessPlaywright: async () => ({
      browser: {
        async newContext(opts) {
          events.push({ op: "context", opts });
          return {
            async newPage() {
              return page;
            },
          };
        },
        async close() {
          events.push({ op: "close" });
        },
      },
    }),
  };
}

async function withEvidence(run) {
  const out = mkdtempSync(join(tmpdir(), "smoke-evidence-"));
  try {
    return await run(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("capture walks the cache-busted shell through Minimal then Full sign-in", async () => {
  await withEvidence(async (out) => {
    const harness = fakeBrowser({ guest: 0, full: 1, withoutAccount: 1 });
    const manifest = await captureLiveSmokeEvidence(
      {
        PAGES_URL: "https://opensesame-labs.github.io/OpenSesame/",
        GITHUB_SHA: sha,
        SMOKE_EVIDENCE_OUT: out,
        GITHUB_WORKSPACE: process.cwd(),
      },
      { launchHeadlessPlaywright: harness.launchHeadlessPlaywright },
    );
    const context = harness.events.find((event) => event.op === "context");
    assert.equal(context.opts.serviceWorkers, "block");
    const goto = harness.events.find((event) => event.op === "goto");
    assert.equal(goto.opts.waitUntil, "load");
    assert.equal(goto.opts.timeout, 45_000);
    assert.equal(
      goto.url,
      `https://opensesame-labs.github.io/OpenSesame/index.html?release=${sha}`,
    );
    const waits = harness.events.filter((event) => event.op === "wait");
    assert.deepEqual(
      waits.map((event) => event.name),
      ["Set up your own", "Minimal", "Full", "Sign in"],
    );
    assert.equal(waits[0].opts.timeout, 20_000);
    assert.equal(waits[1].opts.timeout, 15_000);
    assert.equal(waits[1].opts.state, "visible");
    assert.equal(waits[2].opts.timeout, 15_000);
    assert.equal(waits[2].opts.state, "visible");
    assert.equal(waits[3].opts.timeout, 20_000);
    assert.equal(waits[3].role, "heading");
    assert.equal(waits[3].level, 1);
    const clicks = harness.events.filter((event) => event.op === "click");
    assert.deepEqual(
      clicks.map((event) => event.name),
      ["Set up your own", "Full"],
    );
    const minimalAt = harness.events.findIndex(
      (event) => event.op === "wait" && event.name === "Minimal",
    );
    const fullAt = harness.events.findIndex(
      (event) => event.op === "wait" && event.name === "Full",
    );
    assert.ok(minimalAt > 0 && fullAt > minimalAt);
    assert.equal(manifest.revision, sha);
    assert.equal(
      manifest.pages_url,
      "https://opensesame-labs.github.io/OpenSesame/",
    );
    assert.equal(manifest.browser_entry_url, goto.url);
    assert.equal(Object.keys(manifest.shots).length, 3);
    assert.equal(existsSync(join(out, "failure-screenshot.png")), false);
    assert.equal(existsSync(join(out, "failure-console.json")), false);
    assert.equal(existsSync(join(out, "failure-network.json")), false);
  });
});

test("capture writes failure evidence without lengthening the front-door wait", async () => {
  await withEvidence(async (out) => {
    const handlers = {};
    let frontDoorTimeout;
    const page = {
      on(event, handler) {
        handlers[event] = handler;
      },
      async goto() {
        handlers.console?.({
          type: () => "error",
          text: () => "chunk 404",
        });
        handlers.response?.({
          url: () => "https://example.github.io/OpenSesame/assets/main-abc.js",
          status: () => 404,
          request: () => ({ method: () => "GET" }),
        });
        handlers.requestfailed?.({
          url: () => "https://example.github.io/OpenSesame/assets/vendor.js",
          method: () => "GET",
          failure: () => ({ errorText: "net::ERR_FAILED" }),
        });
      },
      getByRole() {
        return {
          async waitFor(opts) {
            frontDoorTimeout = opts.timeout;
            throw new Error("button missing");
          },
        };
      },
      async screenshot(shot) {
        await writeFile(shot.path, "png");
      },
    };
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  return {
                    async newPage() {
                      return page;
                    },
                  };
                },
                async close() {},
              },
            }),
          },
        ),
      /button missing/,
    );
    assert.equal(frontDoorTimeout, 20_000);
    assert.equal(
      readFileSync(join(out, "failure-screenshot.png"), "utf8"),
      "png",
    );
    const consoleLog = JSON.parse(
      readFileSync(join(out, "failure-console.json"), "utf8"),
    );
    assert.equal(consoleLog.error, "button missing");
    assert.deepEqual(consoleLog.entries, [
      { type: "error", text: "chunk 404" },
    ]);
    const networkLog = JSON.parse(
      readFileSync(join(out, "failure-network.json"), "utf8"),
    );
    assert.equal(networkLog.error, "button missing");
    assert.deepEqual(networkLog.entries, [
      {
        url: "https://example.github.io/OpenSesame/assets/main-abc.js",
        status: 404,
        method: "GET",
      },
      {
        url: "https://example.github.io/OpenSesame/assets/vendor.js",
        method: "GET",
        error: "net::ERR_FAILED",
      },
    ]);
    const summary = JSON.parse(
      readFileSync(join(out, "failure-summary.json"), "utf8"),
    );
    assert.equal(summary.phase, "capture");
    assert.equal(summary.error, "button missing");
  });
});

test("capture still rejects a front door that offers Continue as guest", async () => {
  await withEvidence(async (out) => {
    const harness = fakeBrowser({ guest: 1, full: 1, withoutAccount: 1 });
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          { launchHeadlessPlaywright: harness.launchHeadlessPlaywright },
        ),
      /live front door must not offer Continue as guest/,
    );
  });
});

test("pushDiagnostic keeps a ring buffer of the newest entries", () => {
  const entries = [];
  for (let i = 0; i < 205; i += 1)
    pushDiagnostic(entries, { type: "log", text: String(i) });
  assert.equal(entries.length, 200);
  assert.equal(entries[0].text, "5");
  assert.equal(entries[199].text, "204");
});

test("capture writes failure evidence when browser launch fails", async () => {
  await withEvidence(async (out) => {
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => {
              throw new Error("launch failed");
            },
          },
        ),
      /launch failed/,
    );
    const consoleLog = JSON.parse(
      readFileSync(join(out, "failure-console.json"), "utf8"),
    );
    assert.equal(consoleLog.error, "launch failed");
    const summary = JSON.parse(
      readFileSync(join(out, "failure-summary.json"), "utf8"),
    );
    assert.equal(summary.phase, "launch");
  });
});

test("capture preserves the launch error when evidence writing fails", async () => {
  await withEvidence(async (out) => {
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => {
              // The bootstrapped evidence directory vanishes before the
              // pre-page failure write, so writing evidence must throw.
              rmSync(out, { recursive: true, force: true });
              throw new Error("launch failed");
            },
          },
        ),
      /launch failed/,
    );
    assert.equal(existsSync(out), false);
  });
});

test("capture labels context and page failures distinctly from launch", async () => {
  await withEvidence(async (out) => {
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  throw new Error("context boom");
                },
              },
            }),
          },
        ),
      /context boom/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(out, "failure-summary.json"), "utf8")).phase,
      "context",
    );

    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  return {
                    async newPage() {
                      throw new Error("page boom");
                    },
                  };
                },
              },
            }),
          },
        ),
      /page boom/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(out, "failure-summary.json"), "utf8")).phase,
      "page",
    );
  });
});

test("capture redacts secrets in failure artifacts", async () => {
  await withEvidence(async (out) => {
    const handlers = {};
    const page = {
      on(event, handler) {
        handlers[event] = handler;
      },
      async goto() {
        handlers.console?.({
          type: () => "error",
          text: () => 'fetch failed {"token":"abc123"} at chunk load',
        });
        handlers.requestfailed?.({
          url: () => "https://example.github.io/OpenSesame/assets/x.js",
          method: () => "GET",
          failure: () => ({ errorText: "net::ERR_FAILED token=sekrit" }),
        });
      },
      getByRole() {
        return {
          async waitFor() {
            throw new Error("button missing token=leaked");
          },
        };
      },
      async screenshot(shot) {
        await writeFile(shot.path, "png");
      },
    };
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  return {
                    async newPage() {
                      return page;
                    },
                  };
                },
                async close() {},
              },
            }),
          },
        ),
      /button missing/,
    );
    const consoleLog = JSON.parse(
      readFileSync(join(out, "failure-console.json"), "utf8"),
    );
    assert.equal(consoleLog.error, "button missing [redacted]");
    assert.deepEqual(consoleLog.entries, [
      {
        type: "error",
        text: 'fetch failed {"token":"[redacted]"} at chunk load',
      },
    ]);
    const networkLog = JSON.parse(
      readFileSync(join(out, "failure-network.json"), "utf8"),
    );
    assert.deepEqual(networkLog.entries, [
      {
        url: "https://example.github.io/OpenSesame/assets/x.js",
        method: "GET",
        error: "net::ERR_FAILED [redacted]",
      },
    ]);
  });
});

test("a synchronous browser.close failure does not mask the capture error", async () => {
  await withEvidence(async (out) => {
    const page = {
      on() {},
      async goto() {},
      getByRole() {
        return {
          async waitFor() {
            throw new Error("button missing");
          },
        };
      },
      async screenshot(shot) {
        await writeFile(shot.path, "png");
      },
    };
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  return {
                    async newPage() {
                      return page;
                    },
                  };
                },
                close() {
                  throw new Error("close boom");
                },
              },
            }),
          },
        ),
      /button missing/,
    );
    const summary = JSON.parse(
      readFileSync(join(out, "failure-summary.json"), "utf8"),
    );
    assert.equal(summary.error, "button missing");
  });
});

test("capture records pageerror diagnostics", async () => {
  await withEvidence(async (out) => {
    const page = {
      on(event, handler) {
        if (event === "pageerror") {
          handler(new Error("boom"));
        }
      },
      async goto() {},
      getByRole() {
        return {
          async waitFor() {
            throw new Error("missing");
          },
        };
      },
      async screenshot(shot) {
        await writeFile(shot.path, "png");
      },
    };
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          {
            launchHeadlessPlaywright: async () => ({
              browser: {
                async newContext() {
                  return {
                    async newPage() {
                      return page;
                    },
                  };
                },
                async close() {},
              },
            }),
          },
        ),
      /missing/,
    );
    const consoleLog = JSON.parse(
      readFileSync(join(out, "failure-console.json"), "utf8"),
    );
    assert.equal(
      consoleLog.entries.some((e) => e.type === "pageerror"),
      true,
    );
  });
});

test("capture still requires the Full choice and the sign-in road", async () => {
  await withEvidence(async (out) => {
    const missingFull = fakeBrowser({ guest: 0, full: 0, withoutAccount: 1 });
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          { launchHeadlessPlaywright: missingFull.launchHeadlessPlaywright },
        ),
      /Full install profile choice missing on live Pages/,
    );
    const missingRoad = fakeBrowser({ guest: 0, full: 1, withoutAccount: 0 });
    await assert.rejects(
      () =>
        captureLiveSmokeEvidence(
          {
            PAGES_URL: "https://example.github.io/OpenSesame/",
            GITHUB_SHA: sha,
            SMOKE_EVIDENCE_OUT: out,
          },
          { launchHeadlessPlaywright: missingRoad.launchHeadlessPlaywright },
        ),
      /Full profile sign-in road missing on live Pages/,
    );
  });
});
