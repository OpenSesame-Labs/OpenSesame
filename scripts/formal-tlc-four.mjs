#!/usr/bin/env node
/** Run TLC on formal-verification subsystem models; writes logs under TLC_LOG_DIR. */

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
  process.exit(1);
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
  "vault-presentation/VaultPresentation",
  "open-vault-lease/OpenVaultLease",
  "pwa-shell-ready/PwaShellReady",
  "sync-manifest/ManifestMerge",
  "autofill-gesture/AutofillGesture",
];

/** TLC must fail these fault configs (negative control). */
const faultConfigs = {
  "onboarding-recovery/OnboardingRecovery": "OnboardingRecoveryBuggy.cfg",
};

function runTlc(dir, configFile, spec, logPath, metadata) {
  return spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      resolve(jar),
      "tlc2.TLC",
      "-metadir",
      metadata,
      "-config",
      configFile,
      `${spec}.tla`,
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

for (const rel of models) {
  const dir = join(repo, "spec/formal-verification", rel.split("/")[0]);
  const spec = rel.split("/")[1];
  const metadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
  const log = join(logDir, `${rel.replace("/", "-")}.log`);
  const result = runTlc(dir, `${spec}.cfg`, spec, log, metadata);
  writeFileSync(
    log,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${result.status}\n`,
  );
  if (result.status !== 0) process.exitCode = 1;

  const faultCfg = faultConfigs[rel];
  if (faultCfg) {
    const faultMetadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
    const faultLog = join(logDir, `${rel.replace("/", "-")}-fault.log`);
    const fault = runTlc(dir, faultCfg, spec, faultLog, faultMetadata);
    writeFileSync(
      faultLog,
      `${fault.stdout ?? ""}\n${fault.stderr ?? ""}\nexit=${fault.status}\n`,
    );
    if (fault.status === 0) {
      console.error(`${rel}: fault config ${faultCfg} passed but must fail TLC`);
      process.exitCode = 1;
    }
  }
}
console.log(`TLC logs: ${logDir}`);
