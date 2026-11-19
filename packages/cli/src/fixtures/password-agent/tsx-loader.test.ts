import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tsxLoader } from "./tsx-loader.js";

describe("tsx-loader", () => {
  it("resolves the tsx ESM loader entry", () => {
    expect(tsxLoader).toMatch(/loader\.mjs$/);
  });

  it("runs node --import with the resolved loader", async () => {
    const code = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", tsxLoader, "-e", "console.log('ok')"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) {
          reject(new Error(`exit ${status}: ${err}`));
          return;
        }
        resolve(out.trim());
      });
    });
    expect(code).toBe("ok");
  });
});
