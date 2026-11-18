import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/interaction-clock/coverage.json`, "utf8"),
);
const paths = [
  "packages/control-plane/src/services/interaction-clock.ts",
  "packages/control-plane/src/routes/interaction-activation-spend.ts",
  "packages/control-plane/src/routes/interaction-activation-deadline.ts",
  "packages/control-plane/src/routes/interaction-activation.ts",
  "packages/control-plane/src/routes/interaction-activation-totp.ts",
  "packages/control-plane/src/routes/interaction-handoff.ts",
  "packages/control-plane/src/services/interaction-settlement.ts",
  "packages/control-plane/src/__tests__/interaction-settlement-clock.security.test.ts",
  "packages/os-domain/src/machines/interaction.ts",
  "packages/os-domain/src/errors.ts",
];
if (
  coverage.version !== 1 ||
  !/^[0-9a-f]{40}$/.test(coverage.reviewed_revision) ||
  !Array.isArray(coverage.sources) ||
  coverage.sources.length !== paths.length ||
  paths.some((path, index) => coverage.sources[index]?.path !== path)
) {
  throw new Error("interaction-clock-formal: invalid covered-source manifest");
}
for (const entry of coverage.sources) {
  const digest = createHash("sha256")
    .update(readFileSync(`${root}/${entry.path}`))
    .digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`interaction-clock-formal: source drift in ${entry.path}`);
  }
}
console.log("interaction-clock-formal: reviewed source hashes match");
