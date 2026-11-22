/**
 * Regenerate after reviewing a changed SAML command contract:
 * npm exec -w @opensesame/control-plane -- tsx ../../apps/pages/scripts/write-saml-worker-parser.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SAML_POST_BYTES,
  SamlPostCommandSchema,
} from "@opensesame/app-core/browser/saml/post-wire.js";
import { formatSamlWorkerParser } from "./generate-saml-worker-parser.mjs";
import {
  checkSamlWorkerContents,
  samlWorkerInputs,
} from "./saml-worker-freshness.mjs";

const output = fileURLToPath(
  new URL("../src/sw/saml-command.generated.ts", import.meta.url),
);
const source = formatSamlWorkerParser(
  SamlPostCommandSchema,
  SAML_POST_BYTES,
  samlWorkerInputs(),
);
if (process.argv.slice(2).join(" ") === "--check") {
  checkSamlWorkerContents(readFileSync(output, "utf8"), source);
} else if (process.argv.length === 2) {
  writeFileSync(output, source);
} else {
  throw new Error("Usage: write-saml-worker-parser.ts [--check]");
}
