import { readFileSync } from "node:fs";
import {
  namedStatement,
  parseTypeScript,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

// This reviewed snapshot fails closed if the custody implementation changes.
const snapshot = parseTypeScript(
  readFileSync(
    new URL("./passkey-custody-reviewed.txt", import.meta.url),
    "utf8",
  ),
  "passkey-custody-reviewed.ts",
);
const names = [
  "isBooleanOutcome",
  "copyCredential",
  "createMemoryPasskeyCredentialStore",
  "createPasskeySeam",
];

export function checkPasskeyCustody(source) {
  const file = parseTypeScript(source, "passkey.ts");
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((item) => sourceTokens(item.getText(file)));
  requireSupportedSource(
    imports.includes(
      sourceTokens('import { randomUUID } from "node:crypto";'),
    ) &&
      imports.includes(
        sourceTokens(
          'import { DomainError, ownBytes } from "@opensesame/os-domain";',
        ),
      ),
    "passkey crypto or byte-copy bindings changed",
  );
  for (const name of names) {
    const fn = namedStatement(file, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    requireSupportedSource(
      sourceTokens(fn.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `passkey custody function ${name} changed`,
    );
  }
}
