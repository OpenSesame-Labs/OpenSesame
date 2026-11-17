import {
  namedStatement,
  parseTypeScript,
  pathIs,
  requireDirectFunctionUses,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const body = [
  "assertNotExpired(session, now);",
  'if (session.state !== "reviewed") { throw invalidTransition(session.state, "completed", "claim"); }',
  'if (!completedByPrincipalId) { throw new DomainError("INVARIANT_VIOLATION", "Claim completion requires a principal", { id: session.id },); }',
  'return apply(session, "completed", { completedAt: now, completedByPrincipalId, });',
].map(sourceTokens);

function checkParameter(parameter, name, type, file) {
  return (
    pathIs(parameter.name, name) &&
    parameter.type?.getText(file) === type &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken
  );
}

function checkParameters(fn, file) {
  const [session, principal, now] = fn.parameters;
  requireSupportedSource(
    checkParameter(session, "session", "ClaimSession", file) &&
      !session.initializer &&
      checkParameter(principal, "completedByPrincipalId", "string", file) &&
      !principal.initializer &&
      checkParameter(now, "now", "Date", file) &&
      now.initializer &&
      sourceTokens(now.initializer.getText(file)) ===
        sourceTokens("new Date()"),
    "claim completion parameters changed",
  );
}

function checkSignature(fn, file) {
  requireSupportedSource(
    fn.body &&
      fn.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      !fn.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) &&
      !fn.asteriskToken &&
      !fn.typeParameters?.length &&
      fn.type?.getText(file) === "ClaimSession" &&
      fn.parameters.length === 3,
    "claim completion signature changed",
  );
  checkParameters(fn, file);
}

/** Check the entire completion function before deriving its guard. */
export function checkClaimCompletion(source) {
  const file = parseTypeScript(source, "claim.ts");
  const fn = namedStatement(file, ts.isFunctionDeclaration, "completeClaim");
  checkSignature(fn, file);
  requireDirectFunctionUses(file, fn);
  requireSupportedSource(
    fn.body.statements.length === body.length &&
      body.every(
        (expected, index) =>
          sourceTokens(fn.body.statements[index].getText(file)) === expected,
      ),
    "claim completion guard or returned bindings changed",
  );
}
