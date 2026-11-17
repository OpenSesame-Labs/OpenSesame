import {
  callIs,
  functionSignature,
  namedVariable,
  occurrences,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  ts,
} from "./ast.mjs";

function safeMethods(file) {
  const declaration = namedVariable(file, "SAFE_METHODS");
  const initial = declaration.initializer;
  requireSupportedSource(
    initial &&
      ts.isNewExpression(initial) &&
      pathIs(initial.expression, "Set") &&
      !initial.typeArguments?.length &&
      initial.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(initial.arguments[0]),
    "SAFE_METHODS initializer changed",
  );
  const methods = initial.arguments[0].elements;
  requireSupportedSource(
    methods.length === 3 &&
      methods.every(ts.isStringLiteral) &&
      methods.map((item) => item.text).join(",") === "GET,HEAD,OPTIONS" &&
      occurrences(file, "SAFE_METHODS").length === 2 &&
      occurrences(file, "Set").length === 1 &&
      occurrences(file, "URL").length === 1,
    "SAFE_METHODS must be the unchanged private safe-method set",
  );
}

function booleanExpression(node) {
  if (ts.isParenthesizedExpression(node))
    return booleanExpression(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (pathIs(node, "origin")) return "present";
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  )
    return `(!${booleanExpression(node.operand)})`;
  if (ts.isBinaryExpression(node)) {
    const operators = new Map([
      [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
      [ts.SyntaxKind.BarBarToken, "||"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    requireSupportedSource(operator, "unsupported cookie Boolean operator");
    return `(${booleanExpression(node.left)} ${operator} ${booleanExpression(node.right)})`;
  }
  if (
    callIs(node, ["SAFE_METHODS", "has"], 1) &&
    callIs(node.arguments[0], ["method", "toUpperCase"], 0)
  )
    return "safe";
  if (
    callIs(node, ["ctx", "config", "corsOrigins", "includes"], 1) &&
    pathIs(node.arguments[0], "origin")
  )
    return "listed";
  throw new Error(
    "Unsupported authentication source: unknown cookie expression",
  );
}

function urlComparison(node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !pathIs(node.right, "origin") ||
    !ts.isPropertyAccessExpression(node.left) ||
    node.left.questionDotToken ||
    node.left.name.text !== "origin"
  )
    return false;
  const construct = node.left.expression;
  return (
    ts.isNewExpression(construct) &&
    pathIs(construct.expression, "URL") &&
    !construct.typeArguments?.length &&
    construct.arguments?.length === 1 &&
    pathIs(construct.arguments[0], "ctx", "config", "publicUrl")
  );
}

function tryFlow(first, rest) {
  requireSupportedSource(
    rest.length === 0 &&
      first.catchClause &&
      !first.finallyBlock &&
      !first.catchClause.variableDeclaration &&
      first.tryBlock.statements.length === 1,
    "unsupported cookie try/catch",
  );
  const statement = first.tryBlock.statements[0];
  requireSupportedSource(
    ts.isReturnStatement(statement) &&
      statement.expression &&
      urlComparison(statement.expression),
    "unsupported public-origin comparison",
  );
  const fallback = flow(first.catchClause.block.statements);
  return `(match sameOrigin with | some value => value | none => ${fallback})`;
}

function flow(statements) {
  requireSupportedSource(
    statements.length > 0,
    "cookie decision can fall through",
  );
  const [first, ...rest] = statements;
  if (ts.isReturnStatement(first)) {
    requireSupportedSource(
      rest.length === 0 &&
        first.expression &&
        (first.expression.kind === ts.SyntaxKind.TrueKeyword ||
          first.expression.kind === ts.SyntaxKind.FalseKeyword),
      "cookie return must be a Boolean literal",
    );
    return booleanExpression(first.expression);
  }
  if (ts.isIfStatement(first)) {
    const next = rest.length ? flow(rest) : null;
    const branch = (statement) =>
      flow(ts.isBlock(statement) ? statement.statements : [statement]);
    requireSupportedSource(
      first.elseStatement || next,
      "cookie if can fall through",
    );
    const yes = branch(first.thenStatement);
    const no = first.elseStatement ? branch(first.elseStatement) : next;
    return `(if ${booleanExpression(first.expression)} then ${yes} else ${no})`;
  }
  if (ts.isTryStatement(first)) return tryFlow(first, rest);
  throw new Error(
    "Unsupported authentication source: unknown cookie statement",
  );
}

/** Translate only a reviewed, fail-closed subset of the actual decision body. */
export function extractCookie(source) {
  const file = parseTypeScript(source, "auth.ts");
  safeMethods(file);
  const fn = functionSignature(
    file,
    "cookieAuthAllowed",
    [
      ["ctx", "AppContext"],
      ["method", "string"],
      ["origin", "string|undefined"],
    ],
    "boolean",
  );
  return flow(fn.body.statements);
}
