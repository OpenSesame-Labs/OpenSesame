#!/usr/bin/env node
/** Run scratch-break replay tests for #2608 formal subsystems; writes logs under SCRATCH_LOG_DIR. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const logDir =
  process.env.SCRATCH_LOG_DIR ?? "/opt/cursor/artifacts/formal-scratch-breaks";
mkdirSync(logDir, { recursive: true });

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function section(name, fn) {
  const log = join(logDir, `${name}.log`);
  writeFileSync(log, `# ${name} scratch-break\n`);
  const append = (text) => appendFileSync(log, text);
  append("## baseline (must pass)\n");
  try {
    append(fn.baseline());
  } catch (baselineErr) {
    append(
      `BASELINE FAILED: ${baselineErr.stdout ?? baselineErr.message ?? baselineErr}\n`,
    );
    process.exitCode = 1;
    return;
  }
  append("\n## scratch (must fail)\n");
  try {
    fn.scratch();
    append("UNEXPECTED: scratch did not fail\n");
    process.exitCode = 1;
    return;
  } catch (error) {
    append(String(error.stdout ?? error.message ?? error));
  }
  append("\n## revert (must pass again)\n");
  try {
    append(fn.baseline());
  } catch (revertErr) {
    append(`REVERT FAILED: ${revertErr}`);
    process.exitCode = 1;
  }
}

section("release-promotion", {
  baseline: () =>
    run("node", [
      "--test",
      "scripts/release/lib/candidate-published-formal.replay.test.mjs",
    ]),
  scratch: () => {
    const path = "scripts/release/lib/candidate-promotion.mjs";
    const absolute = join(repo, path);
    const text = readFileSync(absolute, "utf8");
    const broken = text.replace(
      `  demand(
    promoted.candidate_id === published.candidate_id &&
      promoted.source_sha === published.source_sha &&
      promoted.run_id === String(published.producer.run_id) &&
      promoted.run_attempt === String(published.producer.run_attempt) &&
      promoted.payload_digest === hash(publishedBytes),
    "Published promotion does not authorize this candidate",
  );`,
      `  // scratch: promotion binding removed`,
    );
    writeFileSync(absolute, broken);
    try {
      run("node", [
        "--test",
        "scripts/release/lib/candidate-published-formal.replay.test.mjs",
      ]);
    } finally {
      writeFileSync(absolute, text);
    }
  },
});

section("control-plane-session", {
  baseline: () =>
    run("npm", [
      "run",
      "test",
      "-w",
      "@opensesame/control-plane",
      "--",
      "--run",
      "auth-formal.replay",
    ]),
  scratch: () => {
    const path = "packages/control-plane/src/middleware/auth.ts";
    const absolute = join(repo, path);
    const text = readFileSync(absolute, "utf8");
    const broken = text.replace(
      "session.revokedAt",
      "/*scratch*/ false && session.revokedAt",
    );
    writeFileSync(absolute, broken);
    try {
      run("npm", [
        "run",
        "test",
        "-w",
        "@opensesame/control-plane",
        "--",
        "--run",
        "auth-formal.replay",
      ]);
    } finally {
      writeFileSync(absolute, text);
    }
  },
});

section("pwa-shell-ready", {
  baseline: () =>
    run("npm", [
      "run",
      "test",
      "-w",
      "@opensesame/pages",
      "--",
      "--run",
      "shell-ready-formal",
    ]),
  scratch: () => {
    const path = "apps/pages/src/bindings/shell-ready.ts";
    const absolute = join(repo, path);
    const text = readFileSync(absolute, "utf8");
    const broken = text.replace(
      "input.awaitingPlanActivation !== true))",
      "false && input.awaitingPlanActivation !== true))",
    );
    writeFileSync(absolute, broken);
    try {
      run("npm", [
        "run",
        "test",
        "-w",
        "@opensesame/pages",
        "--",
        "--run",
        "shell-ready-formal",
      ]);
    } finally {
      writeFileSync(absolute, text);
    }
  },
});

section("onboarding-recovery", {
  baseline: () =>
    run("npm", [
      "run",
      "test",
      "-w",
      "@opensesame/app-core",
      "--",
      "--run",
      "onboarding-recovery-formal",
    ]),
  scratch: () => {
    const path = "packages/app-core/src/lib/vault/store-presentation.ts";
    const absolute = join(repo, path);
    const text = readFileSync(absolute, "utf8");
    const broken = text.replace(
      "awaitingSecondStep: pending && !open",
      "awaitingSecondStep: false",
    );
    writeFileSync(absolute, broken);
    try {
      run("npm", [
        "run",
        "test",
        "-w",
        "@opensesame/app-core",
        "--",
        "--run",
        "onboarding-recovery-formal",
      ]);
    } finally {
      writeFileSync(absolute, text);
    }
  },
});

section("daemon-fill-pairing", {
  baseline: () =>
    run("cargo", [
      "test",
      "-p",
      "opensesame-daemon",
      "an_unpaired_token_is_refused",
      "--",
      "--nocapture",
    ]),
  scratch: () => {
    const path = "crates/daemon/src/fill/caller.rs";
    const absolute = join(repo, path);
    const text = readFileSync(absolute, "utf8");
    const broken = text.replace(
      "if fill.pairings.verify(&caller.origin, &caller.token) {",
      "if true || fill.pairings.verify(&caller.origin, &caller.token) {",
    );
    writeFileSync(absolute, broken);
    try {
      run("cargo", [
        "test",
        "-p",
        "opensesame-daemon",
        "an_unpaired_token_is_refused",
        "--",
        "--nocapture",
      ]);
    } finally {
      writeFileSync(absolute, text);
    }
  },
});

console.log(`Scratch logs: ${logDir}`);
