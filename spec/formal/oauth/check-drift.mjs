import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/oauth/coverage.json`, "utf8"),
);
const paths = [
  "packages/control-plane/src/interactions/federated-leg.ts",
  "packages/control-plane/src/interactions/federated-pending.ts",
  "packages/control-plane/src/interactions/federated-trust-binding.ts",
  "packages/control-plane/src/interactions/federated.ts",
  "packages/control-plane/src/interactions/oauth2.ts",
  "packages/control-plane/src/interactions/trust.ts",
  "packages/control-plane/src/routes/interactions.ts",
];
if (
  coverage.version !== 1 ||
  !/^[0-9a-f]{40}$/.test(coverage.reviewed_base_revision) ||
  !Array.isArray(coverage.sources) ||
  coverage.sources.length !== paths.length ||
  coverage.sources.some((source, index) => source.path !== paths[index])
) {
  throw new Error("oauth-formal: invalid covered-source manifest");
}
for (const { path, sha256 } of coverage.sources) {
  const digest = createHash("sha256")
    .update(readFileSync(`${root}/${path}`))
    .digest("hex");
  if (digest !== sha256)
    throw new Error(
      `oauth-formal: source drift in ${path}; review the model and update coverage.json`,
    );
}
console.log(
  `oauth-formal: reviewed sources match (base ${coverage.reviewed_base_revision})`,
);
