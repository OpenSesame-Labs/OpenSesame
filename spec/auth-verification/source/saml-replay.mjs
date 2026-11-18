import {
  functionSignature,
  namedVariable,
  occurrences,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const body = [
  "for (const [key, expiry] of accepted) if (expiry <= now) accepted.delete(key);",
  "const key = JSON.stringify([claims.issuer, claims.assertionId]);",
  'if (claims.validUntil <= now || accepted.has(key) || accepted.size >= 1024) throw new Error("SAML assertion was already used or replay custody is full",);',
  "accepted.set(key, claims.validUntil);",
].map(sourceTokens);

/** Check the whole synchronous replay decision before deriving its Lean guard. */
export function checkSamlReplay(source) {
  const file = parseTypeScript(source, "assertion-replay.ts");
  const declaration = namedVariable(file, "accepted");
  const initial = declaration.initializer;
  requireSupportedSource(
    initial &&
      ts.isNewExpression(initial) &&
      pathIs(initial.expression, "Map") &&
      initial.arguments?.length === 0 &&
      initial.typeArguments
        ?.map((argument) => argument.getText(file))
        .join(",") === "string,number" &&
      occurrences(file, "accepted").length === 6 &&
      ["Map", "JSON", "Error"].every(
        (name) => !occurrences(file, name).some(ts.isDeclarationName),
      ),
    "SAML replay custody or built-in bindings changed",
  );
  const fn = functionSignature(
    file,
    "claimNativeSamlAssertion",
    [
      ["claims", "SamlProtocolClaims"],
      ["now", "number"],
    ],
    "void",
  );
  requireSupportedSource(
    fn.body.statements.length === body.length &&
      body.every(
        (expected, index) =>
          sourceTokens(fn.body.statements[index].getText(file)) === expected,
      ),
    "SAML replay pruning, key, guard, or insertion changed",
  );
}
