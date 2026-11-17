import { readFileSync } from "node:fs";
import {
  namedStatement,
  parseTypeScript,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const snapshot = parseTypeScript(
  readFileSync(new URL("./issuer-trust-reviewed.txt", import.meta.url), "utf8"),
  "issuer-trust-reviewed.ts",
);
const names = [
  "organizationSignsIn",
  "resolveByoUpstream",
  "resolveOrganizationIssuer",
  "admittedOrganizationTrust",
  "resolveTrustedIssuer",
];

/** The reviewed selector and its local helpers must remain token-identical. */
export function checkIssuerTrust(source) {
  const file = parseTypeScript(source, "trust.ts");
  const imports = (input) =>
    input.statements
      .filter(ts.isImportDeclaration)
      .map((item) => sourceTokens(item.getText(input)));
  requireSupportedSource(
    imports(file).join("\n") === imports(snapshot).join("\n"),
    "issuer trust dependency bindings changed",
  );
  for (const name of names) {
    const fn = namedStatement(file, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    requireSupportedSource(
      sourceTokens(fn.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `issuer trust function ${name} changed`,
    );
  }
}
