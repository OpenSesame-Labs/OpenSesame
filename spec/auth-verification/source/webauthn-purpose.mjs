import {
  functionSignature,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

// Compare tokens, not whitespace-stripped text: string contents and the
// difference between `return false` and `returnfalse` must remain significant.
const prefix = [
  "let clientData: { challenge?: string; type?: string; origin?: string };",
  'try { clientData = overlapCast(JSON.parse(Buffer.from(assertion.clientDataJSON).toString("utf8")),); } catch { return false; }',
  "const challenge = clientData.challenge;",
  "if (!challenge || !isString(challenge)) return false;",
  "const issued = await store.consume(challenge);",
  'const expectedPurpose = assertion.expectedPurpose ?? "authentication";',
  'if (expectedPurpose !== "authentication" && expectedPurpose !== "transaction") { return false; }',
  "if (!issued || issued.purpose !== expectedPurpose) { return false; }",
  "if (issued.principalId && issued.principalId !== credential.principalId) { return false; }",
].map(sourceTokens);

function checkParameters(arrow, file) {
  requireSupportedSource(
    arrow.parameters.length === 2 &&
      pathIs(arrow.parameters[0].name, "assertion") &&
      arrow.parameters[0].type?.getText(file) === "PasskeyAssertion" &&
      pathIs(arrow.parameters[1].name, "credential") &&
      arrow.parameters[1].type?.getText(file) === "PasskeyCredential" &&
      arrow.parameters.every(
        (parameter) =>
          !parameter.initializer &&
          !parameter.questionToken &&
          !parameter.dotDotDotToken,
      ),
    "WebAuthn verifier parameters changed",
  );
}

function checkCallback(arrow, file) {
  requireSupportedSource(
    arrow &&
      ts.isArrowFunction(arrow) &&
      arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
      !arrow.typeParameters?.length &&
      !arrow.type &&
      ts.isBlock(arrow.body) &&
      arrow.body.statements.length === 11,
    "WebAuthn verifier callback changed",
  );
  checkParameters(arrow, file);
}

/** Check the complete prefix before an assertion reaches its verifier. */
export function checkWebauthnPurpose(source) {
  const file = parseTypeScript(source, "webauthn.ts");
  const fn = functionSignature(
    file,
    "createSimpleWebAuthnVerifyFn",
    [
      ["rp", "WebAuthnRpConfig"],
      ["store", "PasskeyChallengeStore"],
    ],
    "PasskeyVerifyFn",
  );
  requireSupportedSource(
    fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]),
    "WebAuthn verifier wrapper changed",
  );
  const arrow = fn.body.statements[0].expression;
  checkCallback(arrow, file);
  requireSupportedSource(
    prefix.every(
      (expected, index) =>
        sourceTokens(arrow.body.statements[index].getText(file)) === expected,
    ),
    "WebAuthn challenge, purpose, or principal guard changed",
  );
}
