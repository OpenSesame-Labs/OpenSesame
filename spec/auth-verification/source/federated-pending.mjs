import { readFileSync } from "node:fs";
import {
  namedStatement,
  namedVariable,
  parseTypeScript,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const snapshot = parseTypeScript(
  readFileSync(
    new URL("./federated-pending-reviewed.txt", import.meta.url),
    "utf8",
  ),
  "federated-pending-reviewed.ts",
);
const names = [
  "pendingVerifierBinding",
  "pendingIntegrityPayload",
  "pendingSignature",
  "authenticatedPayload",
  "modernPendingSignature",
  "signatureMatches",
  "encodePending",
  "verifiedPendingPayload",
  "decodePending",
];

export function checkFederatedPending(source) {
  const file = parseTypeScript(source, "federated-pending.ts");
  const imports = (input) =>
    input.statements
      .filter(ts.isImportDeclaration)
      .map((item) => sourceTokens(item.getText(input)));
  requireSupportedSource(
    imports(file).join("\n") === imports(snapshot).join("\n"),
    "federation cookie dependency bindings changed",
  );
  const schema = namedVariable(file, "pendingFederatedAuthSchema");
  const reviewedSchema = namedVariable(snapshot, "pendingFederatedAuthSchema");
  requireSupportedSource(
    sourceTokens(schema.getText(file)) ===
      sourceTokens(reviewedSchema.getText(snapshot)),
    "federation cookie schema changed",
  );
  for (const name of names) {
    const fn = namedStatement(file, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    requireSupportedSource(
      sourceTokens(fn.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `federation cookie function ${name} changed`,
    );
  }
}
