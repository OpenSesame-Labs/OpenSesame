import {
  callIs,
  functionSignature,
  occurrences,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  ts,
} from "./ast.mjs";

function comparison(node) {
  const operator = node.operatorToken.kind;
  requireSupportedSource(
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken,
    "unsupported principal comparison",
  );
  let fact;
  if (
    pathIs(node.left, "principal") &&
    node.right.kind === ts.SyntaxKind.NullKeyword
  )
    fact = "isNull";
  else if (pathIs(node.left, "principal") && pathIs(node.right, "undefined"))
    fact = "isUndefined";
  else if (
    pathIs(node.left, "principal", "state") &&
    ts.isStringLiteral(node.right) &&
    node.right.text === "suspended"
  )
    fact = "suspended";
  else if (
    pathIs(node.left, "principal", "state") &&
    ts.isStringLiteral(node.right) &&
    node.right.text === "closed"
  )
    fact = "closed";
  else
    throw new Error(
      "Unsupported authentication source: unknown principal comparison",
    );
  const value =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ? `(!${fact})`
      : fact;
  return fact === "suspended" || fact === "closed"
    ? `(if isNull || isUndefined then none else some ${value})`
    : `(some ${value})`;
}

function expression(node) {
  if (ts.isParenthesizedExpression(node)) return expression(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "(some true)";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "(some false)";
  requireSupportedSource(
    ts.isBinaryExpression(node),
    "unsupported principal expression",
  );
  if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return `(jsAnd ${expression(node.left)} ${expression(node.right)})`;
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    return `(jsOr ${expression(node.left)} ${expression(node.right)})`;
  return comparison(node);
}

/** Translate the completed principal lookup and its Boolean eligibility check. */
export function extractPrincipal(source) {
  const file = parseTypeScript(source, "auth.ts");
  requireSupportedSource(
    !occurrences(file, "undefined").some(ts.isDeclarationName),
    "undefined is shadowed in authentication source",
  );
  const fn = functionSignature(
    file,
    "principalStillAuthenticates",
    [
      ["ctx", "AppContext"],
      ["principalId", "string"],
    ],
    "Promise<boolean>",
    { exported: false, asynchronous: true },
  );
  requireSupportedSource(
    fn.body.statements.length === 2 &&
      ts.isVariableStatement(fn.body.statements[0]) &&
      ts.isReturnStatement(fn.body.statements[1]),
    "principal admission body changed",
  );
  const statement = fn.body.statements[0];
  requireSupportedSource(
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.length === 1,
    "principal lookup must use a const",
  );
  const declaration = statement.declarationList.declarations[0];
  requireSupportedSource(
    pathIs(declaration.name, "principal") &&
      !declaration.type &&
      declaration.initializer &&
      ts.isAwaitExpression(declaration.initializer),
    "principal lookup changed",
  );
  const lookup = declaration.initializer.expression;
  requireSupportedSource(
    callIs(lookup, ["ctx", "repos", "principals", "getById"], 1) &&
      pathIs(lookup.arguments[0], "principalId"),
    "principal lookup target changed",
  );
  const result = fn.body.statements[1].expression;
  requireSupportedSource(result, "principal admission must return a result");
  return expression(result);
}
