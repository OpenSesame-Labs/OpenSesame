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
          return text === "Use without an account" ? counts.withoutAccount : 0;
        },
      };
    },
    async screenshot(shot) {
      await writeFile(shot.path, "png");
    },
  };
  return {
    events,
    launchHeadlessPlaywright: launchPage(page, undefined, (opts) =>
      events.push({ op: "context", opts }),
    ),
  };
}

function evidenceTest(name, run) {
  test(name, async () => {
    const out = mkdtempSync(join(tmpdir(), "smoke-evidence-"));
    try {
      await run(out);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

function capture(out, launchHeadlessPlaywright, options = {}) {
  return captureLiveSmokeEvidence(
    {
      PAGES_URL: "https://example.github.io/OpenSesame/",
      GITHUB_SHA: sha,
      SMOKE_EVIDENCE_OUT: out,
      ...options,
    },
    { launchHeadlessPlaywright },
  );
}

function launchPage(page, close = async () => {}, onContext = () => {}) {
  return async () => ({
    browser: {
      async newContext(opts) {
        onContext(opts);
        return {
          async newPage() {
            return page;
          },
        };
      },
      close,
    },
  });
}

function failingPage(
  message,
  { on = () => {}, goto = async () => {}, wait = () => {} } = {},
) {
  return {
    on,
    goto,
    getByRole: () => ({
      async waitFor(options) {
        wait(options);
        throw new Error(message);
      },
    }),
    async screenshot(shot) {
      await writeFile(shot.path, "png");
    },
  };
}

const evidence = (out, file) =>
  JSON.parse(readFileSync(join(out, file), "utf8"));

evidenceTest("capture walks setup to sign-in", async (out) => {
  const harness = fakeBrowser({ guest: 0, full: 1, withoutAccount: 1 });
  const manifest = await capture(out, harness.launchHeadlessPlaywright, {
    PAGES_URL: "https://opensesame-labs.github.io/OpenSesame/",
    GITHUB_WORKSPACE: process.cwd(),
  });
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

evidenceTest("capture records a front-door timeout", async (out) => {
  const handlers = {};
  let frontDoorTimeout;
  const page = failingPage("button missing", {
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
    wait(opts) {
      frontDoorTimeout = opts.timeout;
    },
  });
  await assert.rejects(() => capture(out, launchPage(page)), /button missing/);
  assert.equal(frontDoorTimeout, 20_000);
  assert.equal(
    readFileSync(join(out, "failure-screenshot.png"), "utf8"),
    "png",
  );
  const consoleLog = evidence(out, "failure-console.json");
  assert.equal(consoleLog.error, "button missing");
  assert.deepEqual(consoleLog.entries, [{ type: "error", text: "chunk 404" }]);
  const networkLog = evidence(out, "failure-network.json");
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
  const summary = evidence(out, "failure-summary.json");
  assert.equal(summary.phase, "capture");
  assert.equal(summary.error, "button missing");
});

evidenceTest(
  "capture rejects the guest option on the front door",
  async (out) => {
    const harness = fakeBrowser({ guest: 1, full: 1, withoutAccount: 1 });
    await assert.rejects(
      () => capture(out, harness.launchHeadlessPlaywright),
      /live front door must not offer Continue as guest/,
    );
  },
);

test("pushDiagnostic keeps a ring buffer of the newest entries", () => {
  const entries = [];
  for (let i = 0; i < 205; i += 1)
    pushDiagnostic(entries, { type: "log", text: String(i) });
  assert.equal(entries.length, 200);
  assert.equal(entries[0].text, "5");
  assert.equal(entries[199].text, "204");
});

evidenceTest("capture records a launch failure", async (out) => {
  await assert.rejects(
    () =>
      capture(out, async () => {
        throw new Error("launch failed");
      }),
    /launch failed/,
  );
  const consoleLog = evidence(out, "failure-console.json");
  assert.equal(consoleLog.error, "launch failed");
  const summary = evidence(out, "failure-summary.json");
  assert.equal(summary.phase, "launch");
});

evidenceTest(
  "capture preserves launch errors when evidence writing fails",
  async (out) => {
    await assert.rejects(
      () =>
        capture(out, async () => {
          // The evidence directory vanishes before the pre-page failure write.
          rmSync(out, { recursive: true, force: true });
          throw new Error("launch failed");
        }),
      /launch failed/,
    );
    assert.equal(existsSync(out), false);
  },
);

evidenceTest("capture distinguishes context and page failures", async (out) => {
  for (const phase of ["context", "page"]) {
    const browser = {
      async newContext() {
        if (phase === "context") throw new Error("context boom");
        return {
          async newPage() {
            throw new Error("page boom");
          },
        };
      },
    };
    await assert.rejects(
      () => capture(out, async () => ({ browser })),
      new RegExp(`${phase} boom`),
    );
    assert.equal(evidence(out, "failure-summary.json").phase, phase);
  }
});

evidenceTest("capture redacts secrets in failure artifacts", async (out) => {
  const handlers = {};
  const page = failingPage("button missing token=leaked", {
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
  });
  await assert.rejects(() => capture(out, launchPage(page)), /button missing/);
  const consoleLog = evidence(out, "failure-console.json");
  assert.equal(consoleLog.error, "button missing [redacted]");
  assert.deepEqual(consoleLog.entries, [
    {
      type: "error",
      text: 'fetch failed {"token":"[redacted]"} at chunk load',
    },
  ]);
  const networkLog = evidence(out, "failure-network.json");
  assert.deepEqual(networkLog.entries, [
    {
      url: "https://example.github.io/OpenSesame/assets/x.js",
      method: "GET",
      error: "net::ERR_FAILED [redacted]",
    },
  ]);
});

evidenceTest(
  "a browser.close failure does not mask a capture error",
  async (out) => {
    const page = failingPage("button missing");
    await assert.rejects(
      () =>
        capture(
          out,
          launchPage(page, () => {
            throw new Error("close boom");
          }),
        ),
      /button missing/,
    );
    const summary = evidence(out, "failure-summary.json");
    assert.equal(summary.error, "button missing");
  },
);

evidenceTest("capture records pageerror diagnostics", async (out) => {
  const page = failingPage("missing", {
    on(event, handler) {
      if (event === "pageerror") {
        handler(new Error("boom"));
      }
    },
  });
  await assert.rejects(() => capture(out, launchPage(page)), /missing/);
  const consoleLog = evidence(out, "failure-console.json");
  assert.equal(
    consoleLog.entries.some((e) => e.type === "pageerror"),
    true,
  );
});

evidenceTest("capture requires Full setup and sign-in", async (out) => {
  const missingFull = fakeBrowser({ guest: 0, full: 0, withoutAccount: 1 });
  await assert.rejects(
    () => capture(out, missingFull.launchHeadlessPlaywright),
    /Full install profile choice missing on live Pages/,
  );
  const missingRoad = fakeBrowser({ guest: 0, full: 1, withoutAccount: 0 });
  await assert.rejects(
    () => capture(out, missingRoad.launchHeadlessPlaywright),
    /Full profile sign-in road missing on live Pages/,
  );
});
