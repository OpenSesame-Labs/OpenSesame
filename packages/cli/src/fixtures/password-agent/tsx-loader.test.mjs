import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "tsx-loader.ts"));

describe("tsx-loader", () => {
  it("resolves the tsx ESM loader entry", () => {
    const tsxLoader = require.resolve("tsx");
    assert.match(tsxLoader, /loader\.mjs$/);
  });

  it("runs node --import with the resolved loader", async () => {
    const tsxLoader = require.resolve("tsx");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", tsxLoader, "-e", "console.log('ok')"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) reject(new Error(`exit ${status}`));
        else resolve(out.trim());
      });
    });
    assert.equal(code, "ok");
  });
});
