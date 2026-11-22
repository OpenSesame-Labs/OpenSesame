import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/webauthn/coverage.json`, "utf8"),
);
const paths = [
  "packages/os-domain/src/machines/interaction.ts",
  "packages/os-domain/src/interaction.ts",
  "packages/os-domain/src/proofs/approval-seal.ts",
  "packages/os-domain/src/errors.ts",
];
if (
  coverage.version !== 1 ||
  !/^[0-9a-f]{40}$/.test(coverage.reviewed_revision) ||
  !Array.isArray(coverage.sources) ||
  coverage.sources.length !== paths.length ||
  paths.some((path, index) => coverage.sources[index]?.path !== path)
) {
  throw new Error("webauthn-formal: invalid covered-source manifest");
}
for (const entry of coverage.sources) {
  const digest = createHash("sha256")
    .update(readFileSync(`${root}/${entry.path}`))
    .digest("hex");
  if (digest !== entry.sha256)
    throw new Error(
      `webauthn-formal: source drift in ${entry.path}; review the model and update coverage.json`,
    );
}
console.log(
  `webauthn-formal: covered sources match the review hashes based on ${coverage.reviewed_revision}`,
);
