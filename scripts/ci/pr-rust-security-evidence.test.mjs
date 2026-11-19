import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "pr-rust-security-evidence.sh");
const workflowFile = resolve(
  here,
  "../../.github/workflows/pr-rust-security-evidence.yml",
);

async function fixture(zeroAudit = false) {
  const root = await mkdtemp(join(tmpdir(), "pr-rust-evidence-test-"));
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  const calls = join(root, "calls");
  await mkdir(bin);
  await writeFile(
    join(bin, "rustc"),
    "#!/bin/sh\necho 'rustc 1.99.0 (test)'\n",
  );
  await writeFile(
    join(bin, "cargo"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\ncase "$*" in\n  *opensesame-audit*) count=${zeroAudit ? 0 : 1} ;;\n  *) count=1 ;;\nesac\necho "test result: ok. $count passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"\n`,
  );
  await chmod(join(bin, "rustc"), 0o700);
  await chmod(join(bin, "cargo"), 0o700);
  return { root, logs, calls, bin };
}

function run(item, suite = "receipt-owner-mapping") {
  return spawnSync("bash", [script, suite], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      PR_RUST_EVIDENCE_LOG_DIR: item.logs,
    },
  });
}

test("runs only the reviewed matrix and requires discovered tests", async () => {
  const item = await fixture();
  try {
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(item.calls, "utf8")).trim().split("\n");
    assert.equal(calls.length, 12);
    assert(calls.every((call) => call.startsWith("test --locked ")));
    assert(
      calls.some((call) =>
        call.includes(
          "opensesame-gateway --lib --features wasm-connectors,testkit",
        ),
      ),
    );
    assert(
      calls.some((call) =>
        call.includes("opensesame-storage --test certmgr_pact"),
      ),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("fails when a selected command discovers no tests", async () => {
  const item = await fixture(true);
  try {
    const result = run(item);
    assert.notEqual(result.status, 0);
    const calls = (await readFile(item.calls, "utf8")).trim().split("\n");
    assert.equal(calls.length, 2);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("refuses arbitrary suites", async () => {
  const item = await fixture();
  try {
    const result = run(item, "arbitrary-command");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported Rust security evidence suite/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("the trusted controller isolates the candidate from credentials", async () => {
  const workflow = parse(await readFile(workflowFile, "utf8"));
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
  assert.equal(job.env.PR_VISUAL_BASE_SHA, "${{ github.sha }}");

  const checkouts = job.steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.deepEqual(
    checkouts.map((step) => [
      step.with.path,
      step.with.ref,
      step.with["persist-credentials"],
    ]),
    [
      ["base", "${{ github.sha }}", false],
      ["head", "${{ steps.resolve.outputs.head_sha }}", false],
    ],
  );

  const tokenSteps = job.steps.filter((step) => step.env?.GH_TOKEN);
  assert.deepEqual(
    tokenSteps.map((step) => step.name),
    [
      "Resolve a current same-repository PR",
      "Recheck both revisions before retaining evidence",
    ],
  );
  assert.ok(tokenSteps.every((step) => !step.run.includes("head/")));
  const candidate = job.steps.find(
    (step) => step.name === "Run the hardcoded exact-head security matrix",
  );
  assert.equal(candidate.env.GH_TOKEN, undefined);
  assert.equal(candidate["working-directory"], "head");
  assert.match(candidate.run, /pr-rust-security-evidence\.sh/u);
  assert.doesNotMatch(candidate.run, /\$\{\{ inputs\.pull_request \}\}/u);

  const upload = job.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/pr-rust-security-evidence/",
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 14);
});
