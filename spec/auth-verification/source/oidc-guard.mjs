import { callIs, pathIs, requireSupportedSource, ts } from "./ast.mjs";

function comparison(node) {
  const operator = node.operatorToken.kind;
  if (
    callIs(node.left, ["Date", "now"], 0) &&
    pathIs(node.right, "expiresAt")
  ) {
    if (operator === ts.SyntaxKind.GreaterThanEqualsToken)
      return "(some expired)";
    if (operator === ts.SyntaxKind.LessThanToken) return "(some (!expired))";
  }
  if (
    pathIs(node.left, "response", "state") &&
    pathIs(node.right, "pair", "state")
  ) {
    if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      return "(some mismatch)";
    if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken)
      return "(some (!mismatch))";
  }
  if (
    pathIs(node.left, "response", "code", "length") &&
    ts.isNumericLiteral(node.right) &&
    node.right.text === "4096" &&
    operator === ts.SyntaxKind.GreaterThanToken
  )
    return "(codeTooLong code)";
  throw new Error(
    "Unsupported authentication source: unknown OIDC response comparison",
  );
}

/** Translate only the callback's reviewed Boolean response-check expressions. */
export function oidcGuard(node) {
  if (ts.isParenthesizedExpression(node)) return oidcGuard(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "(some true)";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "(some false)";
  if (pathIs(node, "response", "error")) return "(some errorFlag)";
  if (pathIs(node, "response", "code")) return "(some (codePresent code))";
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  )
    return `(jsNot ${oidcGuard(node.operand)})`;
  requireSupportedSource(
    ts.isBinaryExpression(node),
    "unsupported OIDC response expression",
  );
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    return `(jsOr ${oidcGuard(node.left)} ${oidcGuard(node.right)})`;
  if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return `(jsAnd ${oidcGuard(node.left)} ${oidcGuard(node.right)})`;
  return comparison(node);
}
