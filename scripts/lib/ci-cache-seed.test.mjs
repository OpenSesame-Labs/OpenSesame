import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeTest from "node:test";
import {
  MISE_LEGACY_MAIN_PREFIX,
  cacheHitLine,
  directoryHasFile,
} from "./ci-cache-seed.mjs";

// quality:test loads this file with Vitest. The CD contract also runs under node --test.
const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

describe("cache hit log lines", () => {
  it("reports a primary key hit", () => {
    assert.equal(
      cacheHitLine("npm", {
        cacheHit: "true",
        matchedKey: "npm-download-v2-Linux-lock-abc",
        primaryKey: "npm-download-v2-Linux-lock-abc",
        mainSeedPrefixes: ["npm-download-v2-Linux-seed-main-"],
      }),
      "npm cache: primary key hit npm-download-v2-Linux-lock-abc",
    );
  });

  it("reports a restore-key fallback to the main seed prefix", () => {
    const matched = "npm-download-v2-Linux-seed-main-from-main";
    assert.equal(
      cacheHitLine("npm", {
        cacheHit: "false",
        matchedKey: matched,
        primaryKey: "npm-download-v2-Linux-lock-pr",
        mainSeedPrefixes: ["npm-download-v2-Linux-seed-main-"],
      }),
      `npm cache: restore-key fallback to main prefix npm-download-v2-Linux-seed-main- matched ${matched}`,
    );
  });

  it("treats the historical mise prefix as a main seed", () => {
    const matched = "mise-v1-linux-x64-ubuntu24-abc-p691-def";
    assert.equal(
      cacheHitLine("mise", {
        cacheHit: false,
        matchedKey: matched,
        primaryKey: "mise-v2-Linux-node-lock-new",
        mainSeedPrefixes: [
          "mise-v2-Linux-seed-main-node-",
          MISE_LEGACY_MAIN_PREFIX,
        ],
      }),
      `mise cache: restore-key fallback to main prefix ${MISE_LEGACY_MAIN_PREFIX} matched ${matched}`,
    );
  });

  it("reports a miss when nothing matched and the probe directory is empty", () => {
    assert.equal(
      cacheHitLine("rust", {
        cacheHit: "false",
        matchedKey: "",
        primaryKey: "v0-rust-rust-build",
        mainSeedPrefixes: ["v0-rust-rust-build-"],
        probeHasPayload: false,
      }),
      "rust cache: miss primary v0-rust-rust-build",
    );
  });

  it("reports a rust restore-key fallback when the registry probe has files", () => {
    assert.equal(
      cacheHitLine("rust", {
        cacheHit: "false",
        primaryKey: "v0-rust-rust-build",
        mainSeedPrefixes: ["v0-rust-rust-build-"],
        probeHasPayload: true,
      }),
      "rust cache: restore-key fallback to main prefix v0-rust-rust-build-",
    );
  });

  it("names a non-main restore key without calling it a main seed", () => {
    assert.equal(
      cacheHitLine("npm", {
        cacheHit: "false",
        matchedKey: "npm-download-v2-Linux-other-1",
        primaryKey: "npm-download-v2-Linux-lock-abc",
        mainSeedPrefixes: ["npm-download-v2-Linux-seed-main-"],
      }),
      "npm cache: restore-key prefix used npm-download-v2-Linux-other-1",
    );
  });
});

describe("directoryHasFile", () => {
  it("is false for a missing directory and true once a file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-seed-"));
    assert.equal(directoryHasFile(join(root, "missing")), false);
    assert.equal(directoryHasFile(root), false);
    mkdirSync(join(root, "registry", "cache"), { recursive: true });
    assert.equal(directoryHasFile(root), false);
    writeFileSync(join(root, "registry", "cache", "crate.crate"), "x");
    assert.equal(directoryHasFile(root), true);
  });
});
