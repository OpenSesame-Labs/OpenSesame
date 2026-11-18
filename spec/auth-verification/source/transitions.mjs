import {
  functionSignature,
  namedStatement,
  namedVariable,
  occurrences,
  parseTypeScript,
  pathIs,
  requireSupportedSource,
  ts,
} from "./ast.mjs";

const statuses = ["pending", "approved", "denied", "cancelled", "expired"];

function checkStatusImport(file) {
  const matches = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "../types.js"
    )
      continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === "AuthorizationRequestStatus")
        matches.push({ clause, element });
    }
  }
  requireSupportedSource(
    matches.length === 1 &&
      !matches[0].element.propertyName &&
      (matches[0].clause.isTypeOnly || matches[0].element.isTypeOnly),
    "authorization status import changed",
  );
}

function checkStatusType(source) {
  const file = parseTypeScript(source, "types.ts");
  const alias = namedStatement(
    file,
    ts.isTypeAliasDeclaration,
    "AuthorizationRequestStatus",
  );
  requireSupportedSource(
    ts.isUnionTypeNode(alias.type),
    "authorization status is not a literal union",
  );
  const values = alias.type.types.map((member) => {
    requireSupportedSource(
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
      "authorization status contains a non-string literal",
    );
    return member.literal.text;
  });
  requireSupportedSource(
    values.length === statuses.length &&
      new Set(values).size === statuses.length &&
      statuses.every((value) => values.includes(value)),
    "authorization status domain changed",
  );
}

function transitionEntries(declaration) {
  const object = declaration.initializer;
  requireSupportedSource(
    object && ts.isObjectLiteralExpression(object),
    "transition table is not an object literal",
  );
  const entries = new Map();
  for (const property of object.properties) {
    requireSupportedSource(
      ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        ts.isArrayLiteralExpression(property.initializer),
      "unsupported transition table entry",
    );
    const key = property.name.text;
    requireSupportedSource(
      statuses.includes(key) && !entries.has(key),
      "unknown or repeated transition source",
    );
    const values = property.initializer.elements.map((element) => {
      requireSupportedSource(
        ts.isStringLiteral(element) && statuses.includes(element.text),
        "unknown or nonliteral transition target",
      );
      return element.text;
    });
    requireSupportedSource(
      new Set(values).size === values.length,
      "repeated transition target",
    );
    entries.set(key, values);
  }
  requireSupportedSource(
    entries.size === statuses.length,
    "transition table is incomplete",
  );
  return entries;
}

function isReadOnlyLength(node) {
  const element = node.parent;
  if (
    !ts.isElementAccessExpression(element) ||
    element.expression !== node ||
    !pathIs(element.argumentExpression, "request", "status")
  )
    return false;
  const length = element.parent;
  if (
    !ts.isPropertyAccessExpression(length) ||
    length.expression !== element ||
    length.questionDotToken ||
    length.name.text !== "length"
  )
    return false;
  const comparison = length.parent;
  return (
    ts.isBinaryExpression(comparison) &&
    comparison.left === length &&
    comparison.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isNumericLiteral(comparison.right) &&
    comparison.right.text === "0" &&
    ts.isIfStatement(comparison.parent) &&
    comparison.parent.expression === comparison
  );
}

function checkTableUses(file, declaration, transitionUse) {
  const identifiers = occurrences(file, "TRANSITIONS");
  const expected = identifiers.filter(
    (node) =>
      node === declaration.name ||
      node === transitionUse ||
      isReadOnlyLength(node),
  );
  requireSupportedSource(
    identifiers.length === 4 && expected.length === 4,
    "transition table has an unverified reference or mutation",
  );
}

function checkedTransitionFunction(file, declaration) {
  const fn = functionSignature(
    file,
    "canTransition",
    [
      ["from", "AuthorizationRequestStatus"],
      ["to", "AuthorizationRequestStatus"],
    ],
    "boolean",
  );
  requireSupportedSource(
    fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]),
    "canTransition body changed",
  );
  const expression = fn.body.statements[0].expression;
  requireSupportedSource(
    expression &&
      ts.isCallExpression(expression) &&
      !expression.questionDotToken &&
      !expression.typeArguments?.length &&
      expression.arguments.length === 1 &&
      pathIs(expression.arguments[0], "to") &&
      ts.isPropertyAccessExpression(expression.expression) &&
      !expression.expression.questionDotToken &&
      expression.expression.name.text === "includes",
    "canTransition no longer uses the table membership decision",
  );
  const element = expression.expression.expression;
  requireSupportedSource(
    ts.isElementAccessExpression(element) &&
      !element.questionDotToken &&
      pathIs(element.expression, "TRANSITIONS") &&
      pathIs(element.argumentExpression, "from"),
    "canTransition table lookup changed",
  );
  checkTableUses(file, declaration, element.expression);
}

/** Extract the declared graph only after checking the real membership function. */
export function extractTransitions(machineSource, typesSource) {
  checkStatusType(typesSource);
  const file = parseTypeScript(machineSource, "authorization-request.ts");
  checkStatusImport(file);
  const declaration = namedVariable(file, "TRANSITIONS");
  const entries = transitionEntries(declaration);
  checkedTransitionFunction(file, declaration);
  const cases = [];
  for (const from of statuses)
    for (const to of entries.get(from))
      cases.push(`  | .${from}, .${to} => true`);
  return `${cases.join("\n")}\n  | _, _ => false`;
}
