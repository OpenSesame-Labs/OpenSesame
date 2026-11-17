import {
  callIs,
  functionSignature,
  occurrences,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  ts,
} from "./ast.mjs";
import {
  checkProofCall,
  checkSpentAndComplete,
  variable,
} from "./oidc-bindings.mjs";
import { oidcGuard } from "./oidc-guard.mjs";

function throwsError(statement) {
  if (
    !ts.isThrowStatement(statement) ||
    !ts.isNewExpression(statement.expression)
  )
    return false;
  const error = statement.expression;
  return (
    pathIs(error.expression, "Error") &&
    !error.typeArguments?.length &&
    error.arguments?.length === 1 &&
    ts.isStringLiteral(error.arguments[0])
  );
}

function ownerCheck(statement) {
  return (
    ts.isExpressionStatement(statement) &&
    callIs(statement.expression, ["owner", "assertCurrent"], 0)
  );
}

function checkExchange(statement) {
  const initializer = variable(statement, ts.NodeFlags.Const, "token");
  requireSupportedSource(
    ts.isAwaitExpression(initializer) &&
      callIs(initializer.expression, ["exchange"], 6),
    "OIDC token exchange changed",
  );
  const args = initializer.expression.arguments;
  const paths = [
    ["response", "code"],
    ["config"],
    ["discovery"],
    ["redirectUri"],
    ["pair", "codeVerifier"],
    ["fetchImpl"],
  ];
  requireSupportedSource(
    paths.every((path, index) => pathIs(args[index], ...path)),
    "OIDC token exchange bindings changed",
  );
}

function checkCompletion(statements) {
  requireSupportedSource(
    statements.length === 7,
    "OIDC completion steps changed",
  );
  const [
    already,
    consume,
    ownerBefore,
    response,
    exchange,
    ownerAfter,
    result,
  ] = statements;
  requireSupportedSource(
    ts.isIfStatement(already) &&
      pathIs(already.expression, "spent") &&
      !already.elseStatement &&
      throwsError(already.thenStatement),
    "OIDC replay check changed",
  );
  requireSupportedSource(
    ts.isExpressionStatement(consume) &&
      ts.isBinaryExpression(consume.expression) &&
      consume.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      pathIs(consume.expression.left, "spent") &&
      consume.expression.right.kind === ts.SyntaxKind.TrueKeyword,
    "OIDC completion must consume before external calls",
  );
  requireSupportedSource(
    ownerCheck(ownerBefore) && ownerCheck(ownerAfter),
    "OIDC owner checks changed",
  );
  requireSupportedSource(
    ts.isIfStatement(response) &&
      !response.elseStatement &&
      throwsError(response.thenStatement),
    "OIDC response rejection changed",
  );
  checkExchange(exchange);
  requireSupportedSource(
    ts.isReturnStatement(result) && result.expression,
    "OIDC proof return changed",
  );
  checkProofCall(result.expression);
  return oidcGuard(response.expression);
}

/** Translate the callback guard only after verifying its closure and call order. */
export function extractOidc(source) {
  const file = parseTypeScript(source, "transaction.ts");
  const fn = functionSignature(
    file,
    "prepareConfiguredOidc",
    [
      ["input", "ConfiguredOidc"],
      ["redirectUri", "string"],
      ["source", "NativeProviderTransport"],
      ["original", "OidcOwner"],
    ],
    null,
    { asynchronous: true },
  );
  requireSupportedSource(
    occurrences(file, "spent").length === 3 &&
      occurrences(file, "complete").length === 2 &&
      !occurrences(file, "Date").some(ts.isDeclarationName) &&
      !occurrences(file, "Error").some(ts.isDeclarationName),
    "OIDC closure or built-in bindings changed",
  );
  return checkCompletion(checkSpentAndComplete(fn.body.statements));
}
