import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { render, summarize } from "./sarif-summary.mjs";

const script = fileURLToPath(new URL("./sarif-summary.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
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

test("the image job cannot pass when the scanner did not run", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["container-images"];
  // Both moving tags of exactly what the publish workflow's manifest job
  // publishes: the two lists cannot drift apart.
  const published = parse(
    readFileSync(join(root, ".github/workflows/cd-ghcr-publish.yml"), "utf8"),
  ).jobs.manifests.strategy.matrix.include.flatMap((row) =>
    row.platforms.split(" ").map((arch) => ({ image: row.name, arch })),
  );
  assert.equal(published.length, 6);
  assert.deepEqual(job.strategy.matrix, {
    tag: ["next", "latest"],
    target: published,
  });
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.permissions, {
    contents: "read",
    packages: "read",
    "security-events": "write",
  });
  const steps = job.steps;
  const scan = steps.findIndex((step) =>
    String(step.uses ?? "").startsWith("google/osv-scanner-action/"),
  );
  // The scan may exit non-zero on findings; the report check may not.
  assert.equal(steps[scan]["continue-on-error"], true);
  assert.deepEqual(steps[scan].with["scan-args"].split("\n"), [
    "scan",
    "image",
    "--archive",
    "--format=sarif",
    "--output-file=image.sarif",
    "image.tar",
  ]);
  const check = steps[scan + 1];
  assert.match(
    check.run,
    /^node scripts\/security\/sarif-summary\.mjs image\.sarif /,
  );
  assert.equal(check["continue-on-error"], undefined);
  const upload = steps[scan + 2];
  assert.match(
    upload.uses,
    /^github\/codeql-action\/upload-sarif@[a-f0-9]{40}$/,
  );
  assert.equal(upload.with.sarif_file, "image.sarif");
  assert.match(
    upload.with.category,
    /matrix\.target\.image.*matrix\.tag.*matrix\.target\.arch/,
  );
  // The three steps after the pull run exactly when an image was pulled.
  for (const step of [steps[scan], check, upload])
    assert.equal(step.if, "steps.pull.outputs.published == 'true'");
});

test("only an unreleased latest tag may be absent, and the image is never run", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["container-images"];
  const pull = job.steps.find((step) => step.id === "pull").run;
  // Pulled and saved by the platform image's own digest, never by tag.
  assert.match(pull, /docker pull --quiet "\$IMAGE@\$digest"/);
  assert.match(pull, /docker save --output image\.tar "\$IMAGE@\$digest"/);
  assert.match(
    pull,
    /select\(\.platform\.os == "linux" and \.platform\.architecture == \$arch\)/,
  );
  assert.match(pull, /publishes no linux\/\$ARCH image"\n\s*exit 1/);
  assert.equal(/docker (run|exec|create|start)\b/.test(pull), false);
  assert.match(pull, /--password-stdin/);
  assert.match(pull, /trap 'docker logout ghcr\.io' EXIT/);
  // Absence is tolerated for `latest` alone and only for "no such tag".
  const tolerated = pull.slice(
    pull.indexOf("if ! listing="),
    pull.indexOf("# The tag names a list"),
  );
  assert.equal(
    tolerated.includes(
      `[ "$TAG" = latest ] && grep -Eqi 'manifest unknown|no such manifest' `,
    ),
    true,
  );
  // A bare "not found" would also excuse "command not found".
  assert.equal(/not found'/.test(tolerated), false);
  assert.match(tolerated, /published=false/);
  assert.match(tolerated, /exit 1\n\s*fi\n$/);
  assert.equal(job.env.ARCH, "${{ matrix.target.arch }}");
});

test("the dev container image is built from its definition and scanned the same way", () => {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  const job = workflow.jobs["devcontainer-image"];
  assert.deepEqual(job.permissions, {
    contents: "read",
    "security-events": "write",
  });
  const steps = job.steps;
  const build = steps[1].run;
  assert.match(
    build,
    /docker build .*--file \.devcontainer\/Dockerfile .*\.devcontainer\n/,
  );
  assert.match(build, /docker save --output image\.tar /);
  assert.equal(
    /docker (run|exec|create|start|push|login)\b/.test(build),
    false,
  );
  const images = workflow.jobs["container-images"].steps;
  const scanOf = (list) =>
    list.find((step) => String(step.uses ?? "").startsWith("google/"));
  // Same scanner, same arguments, same tolerance as the published images.
  assert.deepEqual(scanOf(steps).with, scanOf(images).with);
  assert.equal(scanOf(steps).uses, scanOf(images).uses);
  assert.equal(scanOf(steps)["continue-on-error"], true);
  const check = steps[steps.indexOf(scanOf(steps)) + 1];
  assert.match(
    check.run,
    /^node scripts\/security\/sarif-summary\.mjs image\.sarif /,
  );
  assert.equal(check["continue-on-error"], undefined);
  assert.equal(check.if, undefined);
  assert.equal(steps.at(-1).with.category, "container-image-devcontainer");
});
