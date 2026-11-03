import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureLiveSmokeEvidence,
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
