import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { measurements } from "./pr-visual-evidence.mjs";
import { validateArtifact, validateDist } from "./pr-visual-safety.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const png = Buffer.from("89504e470d0a1a0a010203", "hex");
const shots = [
  "clipboard-desktop.png",
  "clipboard-phone.png",
  "kdbx-error-desktop.png",
  "kdbx-error-phone.png",
];
const base = "a".repeat(40);
const head = "b".repeat(40);

function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-visual-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("measurements retain numeric browser boxes and reject injected markup", () => {
  const help = "#settings-locking .field__help";
  const output = `  measure #x: 192x44 @0,12\n  measure ${help}: none\n  measure #x: 192x32 @10,-2\n  measure ${help}: 960x45 @0,40\n`;
  assert.deepEqual(measurements(output, ["#x", help]), [
    "192x44 @0,12",
    "none",
    "192x32 @10,-2",
    "960x45 @0,40",
  ]);
  assert.throws(() =>
    measurements(output.replace("none", "<img src=x>"), ["#x", help]),
  );
  assert.throws(() =>
    measurements(output.replace("measure #x", "measure #z"), ["#x", help]),
  );
  assert.throws(() =>
    measurements(output.replace("192x44 @0,12", "none"), ["#x", help]),
  );
});

test("distribution guard refuses a symlink and missing index", (t) => {
  const root = temporary(t);
  assert.throws(() => validateDist(root));
  writeFileSync(path.join(root, "index.html"), "<html></html>");
  assert.equal(validateDist(root).files, 1);
  symlinkSync("/etc/passwd", path.join(root, "outside"));
  assert.throws(() => validateDist(root), /symlink/u);
});

test("artifact guard requires the exact four images, SHA-bound receipt and no links", (t) => {
  const root = temporary(t);
  const digest = createHash("sha256").update(png).digest("hex");
  for (const name of shots) writeFileSync(path.join(root, name), png);
  const receipt = {
    version: 1,
    base,
    head,
    profile: "full",
    measurements: {
      clipboard: {
        selectors: ["#settings-clipboard", "#settings-locking .field__help"],
        before: Array(4).fill("1x1 @0,0"),
        after: Array(4).fill("1x1 @0,0"),
      },
      kdbx: {
        selectors: [".status-bubble"],
        before: Array(2).fill("1x1 @0,0"),
        after: Array(2).fill("1x1 @0,0"),
      },
    },
    screenshots: Object.fromEntries(shots.map((name) => [name, digest])),
  };
  const save = () =>
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify(receipt));
  save();
  validateArtifact(root, base, head);
  assert.throws(() => validateArtifact(root, head, base), /provenance/u);
  receipt.measurements.clipboard.after[0] = "<img src=x>";
  save();
  assert.throws(() => validateArtifact(root, base, head), /measurement/u);
  receipt.measurements.clipboard.after[0] = 42;
  save();
  assert.throws(() => validateArtifact(root, base, head), /measurement/u);
  receipt.measurements.clipboard.after[0] = "1x1 @0,0";
  receipt.extra = "unexpected data";
  save();
  assert.throws(() => validateArtifact(root, base, head), /provenance/u);
  delete receipt.extra;
  save();
  writeFileSync(path.join(root, shots[0]), Buffer.from("not a png"));
  assert.throws(() => validateArtifact(root, base, head), /screenshot/u);
  rmSync(path.join(root, shots[0]));
  symlinkSync("/etc/passwd", path.join(root, shots[0]));
  assert.throws(() => validateArtifact(root, base, head), /linked/u);
});

test("the manually dispatched workflow keeps PR execution away from credentials", () => {
  const file = path.resolve(
    here,
    "../../.github/workflows/pr-visual-evidence.yml",
  );
  const workflow = parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["evidence"]);
  const job = workflow.jobs.evidence;
  assert.deepEqual(job.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.match(job.if, /github\.ref.*default_branch/u);
  const steps = job.steps;
  const checkouts = steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 1);
  assert.deepEqual(
    checkouts.map((step) => [
      step.with.path,
      step.with.ref,
      step.with["persist-credentials"],
      step.with["allow-unsafe-pr-checkout"],
    ]),
    [["base", "${{ github.sha }}", false, false]],
  );
  const materialize = steps.find(
    (step) => step.name === "Materialize the exact PR head after trusted setup",
  );
  assert.ok(materialize);
  assert.match(materialize.run, /pr-visual-materialize-head\.sh/u);
  assert.equal(materialize.env.PR_VISUAL_HEAD_SHA, "${{ steps.resolve.outputs.head_sha }}");
  const tokenSteps = steps.filter((step) => step.env?.GH_TOKEN);
  assert.deepEqual(
    tokenSteps.map((step) => step.name),
    [
      "Resolve a current same-repository PR",
      "Recheck both PR revisions before retaining evidence",
    ],
  );
  assert.ok(tokenSteps.every((step) => !step.run.includes("head/")));
  const mise = steps.find((step) => step.uses?.startsWith("jdx/mise-action@"));
  assert.equal(mise.with.persist_github_token, false);
  const install = steps.find(
    (step) =>
      step.name ===
      "Install trusted base dependencies without lifecycle scripts",
  );
  assert.equal(install["working-directory"], "base");
  assert.match(install.run, /npm ci --ignore-scripts/u);
});

test("the workflow uses the trusted runtime and a constrained artifact path", (t) => {
  const file = path.resolve(
    here,
    "../../.github/workflows/pr-visual-evidence.yml",
  );
  const steps = parse(readFileSync(file, "utf8")).jobs.evidence.steps;
  const runtime = steps.find((step) => step.id === "runtime");
  assert.equal(runtime["working-directory"], "base");
  assert.match(runtime.run, /process\.execPath/u);
  const output = path.join(temporary(t), "github-output");
  const resolved = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", runtime.run],
    {
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    },
  );
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(readFileSync(output, "utf8"), /^binary=\/[^\r\n,]+\n$/u);
  const build = steps.find(
    (step) =>
      step.name === "Build both exact revisions in restricted containers",
  );
  const capture = steps.find(
    (step) => step.name === "Capture and validate synthetic comparisons",
  );
  assert.match(build.run, /pr-visual-sandbox\.sh base/u);
  assert.match(build.run, /pr-visual-sandbox\.sh head/u);
  assert.match(capture.run, /pr-visual-sandbox\.sh capture/u);
  assert.equal(build.env.GH_TOKEN, undefined);
  assert.equal(capture.env.GH_TOKEN, undefined);
  assert.equal(
    build.env.PR_VISUAL_NODE_BINARY,
    "${{ steps.runtime.outputs.binary }}",
  );
  assert.equal(
    capture.env.PR_VISUAL_NODE_BINARY,
    build.env.PR_VISUAL_NODE_BINARY,
  );
  const uploads = steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(uploads.length, 1);
  assert.equal(
    uploads[0].with.path,
    "${{ runner.temp }}/pr-visual/capture/pr-visual/artifact/",
  );
  assert.equal(uploads[0].with["if-no-files-found"], "error");
  assert.equal(uploads[0].with["retention-days"], 14);
});

test("PR selection rejects stale, forked and cross-branch comparisons", async () => {
  const { selectPr } = await import("./pr-visual-ref.mjs");
  const repo = "Owner/Repo";
  const context = {
    repository: repo,
    defaultBranch: "main",
    number: "27",
    controlSha: base,
  };
  const pull = {
    number: 27,
    state: "open",
    base: { sha: base, ref: "main", repo: { full_name: repo } },
    head: { sha: head, repo: { full_name: repo } },
  };
  const branch = { object: { sha: base } };
  assert.deepEqual(selectPr(pull, branch, context), { base, head });
  assert.throws(() => selectPr(pull, { object: { sha: head } }, context));
  assert.throws(() =>
    selectPr(
      { ...pull, head: { ...pull.head, repo: { full_name: "Other/Fork" } } },
      branch,
      context,
    ),
  );
  assert.throws(() =>
    selectPr(
      { ...pull, base: { ...pull.base, ref: "other" } },
      branch,
      context,
    ),
  );
  assert.throws(() =>
    selectPr(pull, branch, { ...context, expectedHead: base }),
  );
  assert.throws(() =>
    selectPr(pull, branch, { ...context, number: "27;echo x" }),
  );
});
