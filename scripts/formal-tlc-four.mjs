#!/usr/bin/env node
/** Run TLC on formal-verification subsystem models; writes logs under TLC_LOG_DIR. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateLedger } from "./formal/ledger.mjs";

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

/** Fault TLC output must name the violated invariant or property. */
const faultEvidence = {
  "onboarding-recovery/OnboardingRecovery": "NoUnlockedWhilePending",
};

function runTlc(dir, configFile, spec, metadata) {
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
  try {
    const result = runTlc(dir, `${spec}.cfg`, spec, metadata);
    writeFileSync(
      log,
      `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${result.status}\n`,
    );
    if (result.status !== 0) process.exitCode = 1;
  } finally {
    rmSync(metadata, { recursive: true, force: true });
  }

  const faultCfg = faultConfigs[rel];
  if (faultCfg) {
    const faultMetadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
    const faultLog = join(logDir, `${rel.replace("/", "-")}-fault.log`);
    try {
      const fault = runTlc(dir, faultCfg, spec, faultMetadata);
      writeFileSync(
        faultLog,
        `${fault.stdout ?? ""}\n${fault.stderr ?? ""}\nexit=${fault.status}\n`,
      );
      const faultOutput = `${fault.stdout ?? ""}${fault.stderr ?? ""}`;
      if (fault.status === 0) {
        console.error(
          `${rel}: fault config ${faultCfg} passed but must fail TLC`,
        );
        process.exitCode = 1;
      } else {
        const needle = faultEvidence[rel];
        if (needle && !faultOutput.includes(needle)) {
          console.error(
            `${rel}: fault config ${faultCfg} failed TLC but output lacks ${needle}`,
          );
          process.exitCode = 1;
        }
      }
    } finally {
      rmSync(faultMetadata, { recursive: true, force: true });
    }
  }
}
const ledger = JSON.parse(
  readFileSync(join(repo, "spec/formal-verification/ledger.json"), "utf8"),
);
const ledgerErrors = validateLedger(ledger, repo);
if (ledgerErrors.length) {
  for (const error of ledgerErrors) console.error(error);
  process.exitCode = 1;
}

console.log(`TLC logs: ${logDir}`);
