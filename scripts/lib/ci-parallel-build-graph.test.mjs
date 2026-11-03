import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

// quality:test loads this file with Vitest. The graph contract also runs under node --test.
const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const ci = readFileSync(
  join(repoRootFromHere(), ".github/workflows/ci.yml"),
  "utf8",
);

function jobs(text) {
  return Object.fromEntries(
    [
      ...text
        .split("\njobs:\n")[1]
        .matchAll(
          /^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm,
        ),
    ].map((match) => [match[1], match[2]]),
  );
}

function needsLine(job) {
  return /\n {4}needs: (.+)\n/.exec(job)?.[1] ?? "";
}

describe("typescript and rust graphs share one parallel edge", () => {
  it("starts both builds from changes and from nothing else", () => {
    const current = jobs(ci);
    assert.equal(needsLine(current["typescript-build"]), "[changes]");
    assert.equal(needsLine(current["rust-build"]), "[changes]");
    assert.doesNotMatch(current["typescript-build"], /\n {4}concurrency:/);
    assert.doesNotMatch(current["rust-build"], /\n {4}concurrency:/);
    assert.doesNotMatch(needsLine(current["typescript-build"]), /rust-build/);
    assert.doesNotMatch(needsLine(current["rust-build"]), /typescript-build/);
  });

  it("keeps the required reporter names and their always() edges", () => {
    const current = jobs(ci);
    assert.match(current.typescript, /name: TypeScript\n/);
    assert.match(current["bundle-check"], /name: Bundle budgets\n/);
    assert.match(current["rust-check"], /name: Rust\n/);
    assert.equal(needsLine(current.typescript), "[changes, typescript-build]");
    assert.equal(
      needsLine(current["bundle-check"]),
      "[changes, typescript-build]",
    );
    assert.equal(needsLine(current["rust-check"]), "[changes, rust-build]");
    assert.equal(ci.match(/ {4}if: always\(\)/g)?.length, 3);
    assert.ok(current["rust-build"].includes("fail-fast: false"));
    assert.ok(
      current["rust-build"].includes(
        "shard: ${{ fromJSON(needs.changes.outputs.rust_shards) }}",
      ),
    );
    assert.ok(
      current["rust-build"].includes("CARGO_SHARD: ${{ matrix.shard }}"),
    );
    assert.ok(current["rust-build"].includes("CARGO_SHARD_COUNT: 4"));
    assert.ok(
      current["rust-build"].includes(
        "matrix.shard == 0 && steps.affected.outputs.bitwarden == 'true'",
      ),
    );
    assert.ok(
      current["rust-build"].includes(
        "runs-on: ${{ fromJSON(needs.changes.outputs.linux_runner) }}",
      ),
    );
    assert.doesNotMatch(
      current["rust-build"],
      /^ {4}runs-on: ubuntu-latest-[0-9]+-cores/m,
    );
    assert.ok(current["rust-build"].includes("Tyler has not approved them."));
  });
});
