import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse: parseYaml } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

test("published base images are pinned, while OSS Verify keeps its local builder contract", () => {
  for (const file of [
    ".devcontainer/Dockerfile",
    "ops/compose/Dockerfile",
    "tests/fuzz/clusterfuzzlite/Dockerfile",
  ]) {
    const text = readFileSync(join(root, file), "utf8");
    const bases = text.split("\n").filter((line) => line.startsWith("FROM "));
    assert.ok(bases.length > 0);
    // A stage alias is pinned when its parent image is digest-pinned.
    const pinnedStages = new Set();
    for (const base of bases) {
      const digest = base.match(
        /@sha256:[a-f0-9]{64}(?: AS ([A-Za-z0-9_.-]+))?$/,
      );
      const alias = base.match(/^FROM ([A-Za-z0-9_.-]+) AS ([A-Za-z0-9_.-]+)$/);
      assert.ok(digest || (alias && pinnedStages.has(alias[1])), base);
      const stage = digest?.[1] ?? alias?.[2];
      if (stage) pinnedStages.add(stage);
    }
  }
  const verify = readFileSync(
    join(root, "tests/fuzz/oss-verify/Dockerfile"),
    "utf8",
  );
  assert.match(verify, /ARG BASE_BUILDER=oss-verify-base-builder/);
  assert.match(verify, /FROM \$\{BASE_BUILDER\}/);
});

test("scorecard npm commands use lockfile-pinned installs", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/autofill-browser.yml"),
    "utf8",
  );
  const manifest = join(root, "apps/browser-extension-autofill/package.json");
  const pin = JSON.parse(readFileSync(manifest, "utf8")).devDependencies;
  assert.equal(pin["@playwright/test"], "1.65.0");
  assert.match(
    workflow,
    /npm ci -w @opensesame\/browser-extension-autofill[\s\S]*node node_modules\/@playwright\/test\/cli\.js install --with-deps chromium/,
  );
  assert.doesNotMatch(workflow, /npm exec|--package=@playwright/);

  for (const file of [
    "scripts/audit/deepsec-gate.sh",
    "scripts/audit/deepsec-grok-scan.sh",
  ]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text, /npm ci --ignore-scripts --prefix "\$WS"/);
    assert.doesNotMatch(text, /npm install --ignore-scripts/);
    assert.doesNotMatch(text, /\(cd "\$WS" && npm ci/);
  }
  const gate = readFileSync(
    join(root, "scripts/audit/deepsec-gate.sh"),
    "utf8",
  );
  assert.doesNotMatch(gate, /npx deepsec init/);
});

test("scheduled security scanning has no unnecessary issue write permission", () => {
  const text = readFileSync(
    join(root, ".github/workflows/security.yml"),
    "utf8",
  );
  assert.doesNotMatch(text, /issues:\s*write/);
  assert.match(text, /GITLEAKS_ENABLE_COMMENTS: "false"/);
  assert.match(text, /security-events: write/);
  assert.match(text, /id-token: write/);
});

/** OSV scanning always runs, pins its actions, and uploads SARIF. */
function assertOsvScannerJob(workflow) {
  const osv = workflow.jobs["osv-scanner"];
  assert.deepEqual(osv.permissions, {
    contents: "read",
    "security-events": "write",
  });
  assert.equal(osv.if, undefined);
  const scan = osv.steps.find((step) =>
    step.uses?.startsWith("google/osv-scanner-action/osv-scanner-action@"),
  );
  const reporter = osv.steps.find((step) =>
    step.uses?.startsWith("google/osv-scanner-action/osv-reporter-action@"),
  );
  const upload = osv.steps.find((step) =>
    step.uses?.startsWith("github/codeql-action/upload-sarif@"),
  );
  for (const step of [scan, reporter, upload]) {
    assert.ok(step);
    assert.equal(step.if, undefined);
    assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
  assert.match(scan.with["scan-args"], /--recursive/);
  assert.match(reporter.with["scan-args"], /--new=osv-results\.json/);
  assert.equal(upload.with.sarif_file, "osv-results.sarif");
}

test("scheduled native auditing fails closed on the real production graph after installing its locked runtime", () => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  assert.ok(workflow.on.schedule.length > 0);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  const job = workflow.jobs["native-go"];
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.if, undefined);
  assert.equal(job.needs, undefined);
  const install = job.steps.findIndex(
    (step) => step.run === "npm ci --ignore-scripts",
  );
  const audit = job.steps.findIndex(
    (step) =>
      step.run === "node tools/pwa-tailscale-native-http/native-audit.mjs",
  );
  assert.ok(install >= 0 && audit > install);
  assert.equal(job.steps[install].run, "npm ci --ignore-scripts");
  const uploads = job.steps.filter((step) =>
    (step.uses ?? "").includes("upload-artifact"),
  );
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].if, "${{ failure() && !cancelled() }}");
  assert.equal(uploads[0].with?.name, "native-audit-failure-logs");
  assert.match(String(uploads[0].with?.path), /native-audit-failure-logs/);
  const redact = job.steps.find((step) =>
    String(step.run ?? "").includes("redactPreparationLog"),
  );
  assert.equal(redact?.if, "${{ failure() && !cancelled() }}");
  for (const step of job.steps) {
    assert.notEqual(step["continue-on-error"], true);
    if (step !== uploads[0])
      assert.doesNotMatch(step.uses ?? "", /upload-artifact/);
  }
  assert.equal(job.steps[audit].if, undefined);
  assert.match(
    String(job.steps[audit].env?.OPENSESAME_AUDIT_DIR),
    /\$\{\{ runner\.temp \}\}.*opensesame-native-audit/,
  );
  assert.doesNotMatch(job.steps[audit].run ?? "", /upload-artifact/);
  assert.ok(workflow.jobs["turn-crypto"]);
  assertOsvScannerJob(workflow);
  // Candidate qualification independently blocks releases on lockfile findings.
  const deep = readFileSync(
    join(root, "scripts/release/deep-check.sh"),
    "utf8",
  );
  assert.match(
    deep,
    /dependencies\)\n +npm run audit:osv\n +npm run audit:cargo-audit/,
  );
  assert.doesNotMatch(deep, /npm run audit:osv[^\n]*\|\|/);
});
