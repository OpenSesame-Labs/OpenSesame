import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(directory, "AuthAdmission.lean"), "utf8");
const runner = await readFile(join(directory, "verify.mjs"), "utf8");
const audit = await readFile(join(directory, "Audit.lean"), "utf8");
const vectorsSource = await readFile(
  join(directory, "DecisionVectors.lean"),
  "utf8",
);
const vectors = await readFile(
  join(directory, "decision-vectors.json"),
  "utf8",
);
const toolchain = await readFile(join(directory, "lean-toolchain"), "utf8");

async function check(modify, modifyVectors = (value) => value) {
  const path = await mkdtemp(join(tmpdir(), "opensesame-lean-audit-"));
  try {
    await writeFile(join(path, "verify.mjs"), runner);
    await writeFile(join(path, "AuthAdmission.lean"), modify(source));
    await writeFile(join(path, "Audit.lean"), audit);
    await writeFile(join(path, "DecisionVectors.lean"), vectorsSource);
    await writeFile(
      join(path, "decision-vectors.json"),
      modifyVectors(vectors),
    );
    await writeFile(join(path, "lean-toolchain"), toolchain);
    const child = spawn(process.execPath, [join(path, "verify.mjs")], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output };
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

test("the declared theorems pass the Lean proof and axiom audit", async () => {
  const result = await check((value) => value);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /checked 12 named theorems/);
});

test("a sorry, an axiom, a missing theorem, and a weakened theorem fail closed", async () => {
  const mutations = [
    (value) => value.replace("  rfl\n", "  sorry\n"),
    (value) =>
      value.replace(
        /theorem unsafe_missing_origin_denied([\s\S]*?) := by\n {2}rfl/,
        "axiom unsafe_missing_origin_denied$1",
      ),
    (value) =>
      value.replaceAll("unsafe_missing_origin_denied", "renamed_theorem"),
    (value) =>
      value.replace(
        /theorem unsafe_missing_origin_denied[\s\S]*? := by\n {2}rfl/,
        "theorem unsafe_missing_origin_denied (allowed : List String) (sameOrigin : Option String) : True := by\n  trivial",
      ),
  ];
  for (const mutate of mutations) {
    assert.notEqual(
      mutate(source),
      source,
      "the deliberate mutation must apply",
    );
    const result = await check(mutate);
    assert.notEqual(result.code, 0, result.output);
  }
});

test("a change that allows a replay invalidates the proof", async () => {
  const mutated = source.replace(
    "if tx.spent then (tx, false)",
    "if false then (tx, false)",
  );
  assert.notEqual(mutated, source);
  const result = await check(() => mutated);
  assert.notEqual(result.code, 0, result.output);
});

test("decision vectors that do not match the proved definitions fail closed", async () => {
  const result = await check(
    (value) => value,
    (value) => value.replace('"cookie": "0', '"cookie": "1'),
  );
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /vectors differ/);
});
