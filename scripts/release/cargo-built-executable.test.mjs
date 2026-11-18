import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "cargo-built-executable.mjs");

describe("cargo-built-executable.mjs", () => {
  it("prints the last executable path for the requested bin", () => {
    const payload = [
      JSON.stringify({
        reason: "compiler-artifact",
        executable: "/cache/release/opensesame",
        target: { name: "opensesame" },
      }),
      JSON.stringify({
        reason: "compiler-artifact",
        executable: "/cache/release/opensesame-surrogate-proxy",
        target: { name: "opensesame-surrogate-proxy" },
      }),
    ].join("\n");
    const path = execFileSync(process.execPath, [script, "opensesame"], {
      input: payload,
      encoding: "utf8",
    }).trim();
    expect(path).toBe("/cache/release/opensesame");
  });

  it("ignores non-json lines from rustc", () => {
    const payload = `warning: example\n${JSON.stringify({
      reason: "compiler-artifact",
      executable: "/triple/aarch64-unknown-linux-gnu/release/opensesame",
      target: { name: "opensesame" },
    })}`;
    const path = execFileSync(process.execPath, [script, "opensesame"], {
      input: payload,
      encoding: "utf8",
    }).trim();
    expect(path).toBe("/triple/aarch64-unknown-linux-gnu/release/opensesame");
  });

  it("buffers artifact JSON split across stdin chunks", async () => {
    const message = JSON.stringify({
      reason: "compiler-artifact",
      executable: "/cache/release/opensesame",
      target: { name: "opensesame" },
    });
    const split = Math.floor(message.length / 2);
    const child = spawn(process.execPath, [script, "opensesame"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const out = await new Promise((resolve, reject) => {
      const chunks = [];
      child.stdout.on("data", (data) => chunks.push(data));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`exit ${code}`));
        else resolve(Buffer.concat(chunks).toString("utf8").trim());
      });
      child.stdin.write(message.slice(0, split));
      setTimeout(() => {
        child.stdin.write(`${message.slice(split)}\n`);
        child.stdin.end();
      }, 5);
    });
    expect(out).toBe("/cache/release/opensesame");
  });
});
