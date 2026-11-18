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
});
