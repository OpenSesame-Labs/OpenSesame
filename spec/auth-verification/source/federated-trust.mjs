import { readFileSync } from "node:fs";
import {
  functionSignature,
  namedStatement,
  parseTypeScript,
  requireDirectFunctionUses,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const snapshot = parseTypeScript(
  readFileSync(
    new URL("./federated-trust-reviewed.txt", import.meta.url),
    "utf8",
  ),
  "federated-trust-reviewed.ts",
);

function imports(input) {
  return input.statements
    .filter(ts.isImportDeclaration)
    .map((item) => sourceTokens(item.getText(input)));
}

function sameTokens(actual, reviewed, message) {
  requireSupportedSource(
    sourceTokens(actual) === sourceTokens(reviewed),
    message,
  );
}

function checkTrustGuards(federated) {
  for (const name of ["resolveOrRefuse", "rejectTrustRebinding"]) {
    const actual = namedStatement(federated, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    sameTokens(
      actual.getText(federated),
      reviewed.getText(snapshot),
      `federated trust guard ${name} changed`,
    );
    requireDirectFunctionUses(federated, actual);
  }
}

/** Bind the reviewed primitive to both the start and callback entry points. */
export function checkFederatedTrust(bindingSource, federatedSource) {
  const binding = parseTypeScript(bindingSource, "federated-trust-binding.ts");
  const federated = parseTypeScript(federatedSource, "federated.ts");
  requireSupportedSource(
    imports(binding).join("\n") === imports(snapshot).join("\n"),
    "federated trust dependency bindings changed",
  );
  for (const name of ["pendingProvenance", "trustMatchesPending"]) {
    const actual = namedStatement(binding, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    sameTokens(
      actual.getText(binding),
      reviewed.getText(snapshot),
      `federated trust function ${name} changed`,
    );
  }

  checkTrustGuards(federated);

  const start = functionSignature(
    federated,
    "beginFederatedAuth",
    [
      ["ctx", "AppContext"],
      ["uid", "string"],
      ["issuer", "string"],
    ],
    "Promise<FederatedAuthStart>",
    { asynchronous: true },
  );
  const returns = [];
  const collectReturns = (node) => {
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collectReturns);
  };
  collectReturns(start.body);
  const firstStart = start.body?.statements[0];
  requireSupportedSource(
    firstStart !== undefined &&
      sourceTokens(firstStart.getText(federated)) ===
        sourceTokens("const trust = await resolveOrRefuse(ctx, issuer);") &&
      returns.length === 1 &&
      sourceTokens(returns[0].getText(federated)) ===
        sourceTokens(
          "return {\n" +
            "  authorizationUrl: url.href,\n" +
            "  pending: { issuer, state, nonce, verifier, ...pendingProvenance(trust) },\n" +
            "};",
        ),
    "federated start no longer records resolved trust provenance",
  );

  const complete = functionSignature(
    federated,
    "completeFederatedAuth",
    [
      ["ctx", "AppContext"],
      ["pending", "PendingFederatedAuth"],
      ["currentUrl", "URL"],
    ],
    "Promise<FederatedIdentity>",
    { asynchronous: true },
  );
  const prefix = complete.body?.statements.slice(0, 3) ?? [];
  requireSupportedSource(
    prefix.length === 3 &&
      sourceTokens(prefix.map((item) => item.getText(federated)).join("\n")) ===
        sourceTokens(
          "const trust = await resolveOrRefuse(ctx, pending.issuer);\n" +
            "if (!trustMatchesPending(trust, pending)) rejectTrustRebinding();\n" +
            "const mode = await clientModeFor(ctx.config, trust);",
        ),
    "federated callback must bind trust before choosing a client or networking",
  );
}
