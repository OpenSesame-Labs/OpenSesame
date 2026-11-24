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
  "legBindingMaterial",
  "verifierSealKey",
  "sealVerifier",
  "unsealVerifier",
  "pendingMac",
  "pendingFromWire",
  "base64urlJson",
  "parseWire",
  "encodePending",
  "decodePending",
];
const variables = [
  "pendingFederatedAuthSchema",
  "unsignedWireSchema",
  "sealedWireSchema",
  "MAX_PENDING_COOKIE_LENGTH",
  "MAC_KEY_LABEL",
  "MAC_DOMAIN",
  "defaultKeys",
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
  for (const name of variables) {
    const variable = namedVariable(file, name);
    const reviewed = namedVariable(snapshot, name);
    requireSupportedSource(
      sourceTokens(variable.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `federation cookie binding ${name} changed`,
    );
  }
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
