import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { render, summarize } from "./sarif-summary.mjs";

const script = fileURLToPath(new URL("./sarif-summary.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "opensesame-sarif-"));
after(() => rmSync(work, { recursive: true, force: true }));

const log = (results) => ({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "osv-scanner" } }, results }],
});

function run(name, contents) {
  const path = join(work, name);
  if (contents !== undefined) writeFileSync(path, contents);
  return spawnSync(process.execPath, [script, path], { encoding: "utf8" });
}

test("findings are counted per advisory, most frequent first", () => {
  const summary = summarize(
    log([
      { ruleId: "CVE-2026-0002" },
      { ruleId: "CVE-2026-0001" },
      { ruleId: "CVE-2026-0002" },
      {},
    ]),
  );
  assert.deepEqual(summary, {
    tools: ["osv-scanner"],
    findings: 4,
    advisories: [
      ["CVE-2026-0002", 2],
      ["CVE-2026-0001", 1],
      ["unidentified", 1],
    ],
  });
  const markdown = render(summary);
  assert.match(markdown, /4 finding\(s\) across 3 advisory identifier\(s\)/);
  assert.match(markdown, /\| CVE-2026-0002 \| 2 \|/);
});

test("a clean report says so and prints no table", () => {
  const markdown = render(summarize(log([])));
  assert.match(markdown, /0 finding\(s\) across 0 advisory identifier\(s\)/);
  assert.equal(markdown.includes("| Advisory |"), false);
});

test("a long list is cut and says how much was left out", () => {
  const results = Array.from({ length: 30 }, (_, n) => ({ ruleId: `A-${n}` }));
  const markdown = render(summarize(log(results)));
  assert.match(markdown, /… and 5 more/);
});

test("a report that is not a complete SARIF log is refused", () => {
  for (const broken of [
    {},
    { version: "2.1.0" },
    { version: "2.1.0", runs: [] },
    {
      version: "2.0.0",
      runs: [{ tool: { driver: { name: "x" } }, results: [] }],
    },
    { version: "2.1.0", runs: [{ results: [] }] },
    { version: "2.1.0", runs: [{ tool: { driver: { name: "x" } } }] },
  ])
    assert.throws(() => summarize(broken));
});

test("the command fails when the scanner produced nothing or something partial", () => {
  const missing = run("absent.sarif");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /did not produce one/);
  const empty = run("empty.sarif", "");
  assert.equal(empty.status, 1);
  const partial = run("partial.sarif", '{"version":"2.1.0","runs":[');
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /Incomplete report/);
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});

test("the command succeeds on a complete report, with or without findings", () => {
  const clean = run("clean.sarif", JSON.stringify(log([])));
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /0 finding/);
  const found = run("found.sarif", JSON.stringify(log([{ ruleId: "GHSA-x" }])));
  assert.equal(found.status, 0);
  assert.match(found.stdout, /\| GHSA-x \| 1 \|/);
});
