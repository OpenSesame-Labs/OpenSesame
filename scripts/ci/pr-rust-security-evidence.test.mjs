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
const workflowFile = resolve(
  here,
  "../../.github/workflows/pr-rust-security-evidence.yml",
);

async function workflow() {
  return parse(await readFile(workflowFile, "utf8"));
}

async function fixture(zeroAudit = false) {
  const root = await mkdtemp(join(tmpdir(), "pr-rust-evidence-test-"));
  const bin = join(root, "bin");
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
  return { root, calls, bin };
}

async function matrix() {
  const definition = await workflow();
  return definition.jobs.evidence.steps.at(-1).run;
}

async function run(item, suite = "receipt-owner-mapping") {
  return spawnSync("bash", ["-c", await matrix()], {
    cwd: item.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      PR_RUST_EVIDENCE_SUITE: suite,
    },
  });
}

test("runs only the reviewed matrix and requires discovered tests", async () => {
  const item = await fixture();
  try {
    const result = await run(item);
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
    const result = await run(item);
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
    const result = await run(item, "arbitrary-command");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported Rust security evidence suite/u);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("candidate execution is isolated from token-bearing jobs", async () => {
  const definition = await workflow();
  assert.deepEqual(Object.keys(definition.on), ["workflow_dispatch"]);
  assert.deepEqual(definition.permissions, {});
  assert.deepEqual(Object.keys(definition.jobs), [
    "resolve",
    "evidence",
    "confirm",
  ]);

  const { resolve: select, evidence, confirm } = definition.jobs;
  assert.deepEqual(select.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(select.env.PR_VISUAL_BASE_SHA, "${{ github.sha }}");
  assert.equal(select.steps.filter((step) => step.env?.GH_TOKEN).length, 1);
  assert.equal(
    select.steps.some((step) => step.with?.path === "head"),
    false,
  );

  assert.equal(evidence.needs, "resolve");
  assert.deepEqual(evidence.permissions, { contents: "read" });
  assert.equal(
    evidence.steps.filter(
      (step) =>
        step.env?.GH_TOKEN &&
        step.name !== "Materialize the exact PR head without actions/checkout",
    ).length,
    0,
  );
  const mise = evidence.steps[1];
  assert.equal(mise.with.working_directory, "${{ runner.temp }}");
  assert.equal(
    evidence.steps.some((step) => step.with?.path === "head"),
    false,
  );
  assert.equal(mise.with.install_args, "rust@1.99.0");
  assert.equal(mise.with.persist_github_token, false);
  const candidate = evidence.steps.at(-1);
  assert.equal(candidate.name, "Run the hardcoded exact-head security matrix");
  assert.equal(candidate["working-directory"], "head");
  assert.match(candidate.run, /^exec bash -c '/u);
  assert.doesNotMatch(candidate.run, /(?:^|\/)base(?:\/|\s|$)/u);
  assert.doesNotMatch(candidate.run, /\bgh\b/u);

  assert.deepEqual(confirm.needs, ["resolve", "evidence"]);
  assert.deepEqual(confirm.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(
    confirm.env.PR_VISUAL_EXPECTED_HEAD,
    "${{ needs.resolve.outputs.head_sha }}",
  );
  assert.equal(confirm.steps.filter((step) => step.env?.GH_TOKEN).length, 1);
  assert.equal(
    confirm.steps.some((step) => step.with?.path === "head"),
    false,
  );

  const allSteps = Object.values(definition.jobs).flatMap((job) => job.steps);
  assert.equal(
    allSteps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    false,
  );
});
