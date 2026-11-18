import { callIs, pathIs, requireSupportedSource, ts } from "./ast.mjs";

export function variable(statement, flags, name) {
  requireSupportedSource(
    ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & flags) !== 0 &&
      statement.declarationList.declarations.length === 1,
    `OIDC ${name} declaration changed`,
  );
  const declaration = statement.declarationList.declarations[0];
  requireSupportedSource(
    pathIs(declaration.name, name) &&
      !declaration.type &&
      declaration.initializer,
    `OIDC ${name} binding changed`,
  );
  return declaration.initializer;
}

function properties(object, expected) {
  requireSupportedSource(
    ts.isObjectLiteralExpression(object) &&
      object.properties.length === expected.size,
    "OIDC object bindings changed",
  );
  const seen = new Set();
  for (const property of object.properties) {
    requireSupportedSource(
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name),
      "unsupported OIDC object property",
    );
    const name = property.name.text;
    const value = expected.get(name);
    requireSupportedSource(
      value && !seen.has(name),
      "unknown or repeated OIDC object property",
    );
    seen.add(name);
    if (value.length === 1 && value[0] === name)
      requireSupportedSource(
        ts.isShorthandPropertyAssignment(property) &&
          !property.objectAssignmentInitializer,
        `OIDC ${name} binding changed`,
      );
    else
      requireSupportedSource(
        ts.isPropertyAssignment(property) &&
          pathIs(property.initializer, ...value),
        `OIDC ${name} binding changed`,
      );
  }
}

export function checkSpentAndComplete(statements) {
  requireSupportedSource(
    statements.length >= 3,
    "OIDC transaction body is incomplete",
  );
  const [spentStatement, completeStatement, returned] = statements.slice(-3);
  const spent = variable(spentStatement, ts.NodeFlags.Let, "spent");
  requireSupportedSource(
    spent.kind === ts.SyntaxKind.FalseKeyword,
    "OIDC transaction must start unspent",
  );
  const complete = variable(completeStatement, ts.NodeFlags.Const, "complete");
  requireSupportedSource(
    ts.isArrowFunction(complete) &&
      complete.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) &&
      !complete.typeParameters?.length &&
      !complete.type &&
      complete.parameters.length === 1 &&
      ts.isBlock(complete.body),
    "OIDC completion function changed",
  );
  const parameter = complete.parameters[0];
  requireSupportedSource(
    pathIs(parameter.name, "response") &&
      !parameter.initializer &&
      !parameter.questionToken &&
      !parameter.dotDotDotToken &&
      parameter.type?.getText().replace(/\s+/g, "") ===
        "Readonly<{state:string;code:string|null;error:boolean}>",
    "OIDC completion input changed",
  );
  requireSupportedSource(
    ts.isReturnStatement(returned) &&
      returned.expression &&
      callIs(returned.expression, ["Object", "freeze"], 1),
    "OIDC transaction result changed",
  );
  properties(
    returned.expression.arguments[0],
    new Map([
      ["manualEndpoints", ["discovery", "manual"]],
      ["authorizationUrl", ["url", "href"]],
      ["state", ["pair", "state"]],
      ["expiresAt", ["expiresAt"]],
      ["complete", ["complete"]],
    ]),
  );
  return complete.body.statements;
}

export function checkProofCall(expression) {
  requireSupportedSource(
    callIs(expression, ["verifyNativeOidcProof"], 1),
    "OIDC proof verifier changed",
  );
  properties(
    expression.arguments[0],
    new Map([
      ["token", ["token"]],
      ["issuer", ["config", "issuer"]],
      ["clientId", ["config", "clientId"]],
      ["nonce", ["pair", "nonce"]],
      ["jwksUri", ["discovery", "jwksUri"]],
      ["organization", ["config", "organization"]],
      ["fetchImpl", ["fetchImpl"]],
      ["owner", ["owner"]],
    ]),
  );
}
