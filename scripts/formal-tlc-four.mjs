#!/usr/bin/env node
/** Run TLC on the four #2608 subsystem models; writes logs under TLC_LOG_DIR. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const logDir =
  process.env.TLC_LOG_DIR ?? "/opt/cursor/artifacts/formal-tlc-four";
mkdirSync(logDir, { recursive: true });

const jar = process.env.TLA2TOOLS_JAR;
if (!jar) {
  writeFileSync(
    join(logDir, "SKIPPED.txt"),
    "TLA2TOOLS_JAR unset; see spec/ui-behavior/README.md",
  );
  console.error("TLA2TOOLS_JAR unset");
  process.exit(0);
}
const digest = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (
  digest !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
) {
  throw new Error("TLA2TOOLS_JAR digest mismatch");
}

const models = [
  "release-promotion/ReleasePromotion",
  "daemon-fill-pairing/DaemonFillPairing",
  "control-plane-session/ControlPlaneSession",
  "onboarding-recovery/OnboardingRecovery",
];

for (const rel of models) {
  const dir = join(repo, "spec/formal-verification", rel.split("/")[0]);
  const spec = rel.split("/")[1];
  const metadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
  const log = join(logDir, `${rel.replace("/", "-")}.log`);
  const result = spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      resolve(jar),
      "tlc2.TLC",
      "-metadir",
      metadata,
      "-config",
      `${spec}.cfg`,
      `${spec}.tla`,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  writeFileSync(
    log,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${result.status}\n`,
  );
  if (result.status !== 0) process.exitCode = 1;
}
console.log(`TLC logs: ${logDir}`);
