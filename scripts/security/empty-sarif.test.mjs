import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OSV_SCANNER_DRIVER, emptySarif } from "./empty-sarif.mjs";
import { summarize } from "./sarif-summary.mjs";

const script = fileURLToPath(new URL("./empty-sarif.mjs", import.meta.url));
const summary = fileURLToPath(new URL("./sarif-summary.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "opensesame-empty-sarif-"));
after(() => rmSync(work, { recursive: true, force: true }));

const write = (path) =>
  spawnSync(process.execPath, [script, path], { encoding: "utf8" });

test("the log is one complete OSV-Scanner run with no results", () => {
  const log = emptySarif();
  assert.equal(log.version, "2.1.0");
  assert.equal(log.runs.length, 1);
  assert.equal(log.runs[0].tool.driver.name, "osv-scanner");
  assert.equal(OSV_SCANNER_DRIVER, "osv-scanner");
  assert.deepEqual(log.runs[0].results, []);
  // The report check that guards every real scan accepts it as complete.
  assert.deepEqual(summarize(log), {
    tools: ["osv-scanner"],
    findings: 0,
    advisories: [],
  });
});

test("the command writes the log and the report check passes on it", () => {
  const path = join(work, "image.sarif");
  const made = write(path);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), emptySarif());
  const checked = spawnSync(process.execPath, [summary, path], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Scanner: osv-scanner\. 0 finding\(s\)/);
});

test("a report already at the path is never replaced", () => {
  const path = join(work, "real.sarif");
  writeFileSync(path, "real findings");
  const refused = write(path);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), "real findings");
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
