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

function declaration(statement) {
  requireSupportedSource(
    ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.length === 1,
    "OIDC evidence lookup changed",
  );
  return statement.declarationList.declarations[0];
}

function isThrow(statement) {
  return (
    ts.isThrowStatement(statement) &&
    ts.isNewExpression(statement.expression) &&
    pathIs(statement.expression.expression, "Error") &&
    statement.expression.arguments?.length === 1 &&
    ts.isStringLiteral(statement.expression.arguments[0])
  );
}

function checkRejections(absent, expired) {
  requireSupportedSource(
    ts.isIfStatement(absent) &&
      !absent.elseStatement &&
      ts.isPrefixUnaryExpression(absent.expression) &&
      absent.expression.operator === ts.SyntaxKind.ExclamationToken &&
      pathIs(absent.expression.operand, "value") &&
      isThrow(absent.thenStatement),
    "OIDC missing evidence rejection changed",
  );
  const condition = ts.isIfStatement(expired) && expired.expression;
  requireSupportedSource(
    condition &&
      !expired.elseStatement &&
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken &&
      pathIs(condition.left, "value", "claims", "validUntil") &&
      callIs(condition.right, ["Date", "now"], 0) &&
      isThrow(expired.thenStatement),
    "OIDC evidence expiry rejection changed",
  );
}

function checkRegistrationValue(call) {
  const object = call.arguments[1].arguments[0];
  requireSupportedSource(
    ts.isObjectLiteralExpression(object) &&
      object.properties.length === 2 &&
      object.properties.every(
        (entry) =>
          ts.isShorthandPropertyAssignment(entry) &&
          !entry.objectAssignmentInitializer &&
          ["claims", "owner"].includes(entry.name.text),
      ) &&
      new Set(object.properties.map((entry) => entry.name.text)).size === 2,
    "OIDC evidence registration value changed",
  );
}

function checkFreshRegistration(call, verify) {
  const steps = verify.body.statements;
  const proof = declaration(steps.at(-3));
  const registered = steps.at(-2);
  const returned = steps.at(-1);
  requireSupportedSource(
    pathIs(proof.name, "proof") &&
      proof.type?.getText().replace(/\s+/g, "") === "NativeOidcProof" &&
      callIs(proof.initializer, ["Object", "freeze"], 1) &&
      ts.isObjectLiteralExpression(proof.initializer.arguments[0]) &&
      ts.isExpressionStatement(registered) &&
      registered.expression === call &&
      ts.isReturnStatement(returned) &&
      pathIs(returned.expression, "proof"),
    "OIDC evidence registration must use a freshly allocated object",
  );
}

function checkSetter(node, verify) {
  const property = node.parent;
  const call = property.parent;
  requireSupportedSource(
    ts.isPropertyAccessExpression(property) &&
      property.name.text === "set" &&
      callIs(call, ["pending", "set"], 2) &&
      pathIs(call.arguments[0], "proof") &&
      callIs(call.arguments[1], ["Object", "freeze"], 1),
    "OIDC evidence registration changed",
  );
  checkRegistrationValue(call);
  checkFreshRegistration(call, verify);
}

function checkPending(file, verify, lookup, remove) {
  const pending = namedVariable(file, "pending");
  const initializer = pending.initializer;
  requireSupportedSource(
    initializer &&
      ts.isNewExpression(initializer) &&
      pathIs(initializer.expression, "WeakMap") &&
      initializer.arguments?.length === 0 &&
      initializer.typeArguments?.length === 2 &&
      ["WeakMap", "Object", "Date", "Error"].every(
        (name) => !occurrences(file, name).some(ts.isDeclarationName),
      ),
    "OIDC evidence storage or built-ins changed",
  );
  const uses = occurrences(file, "pending");
  const other = uses.filter(
    (node) => node !== pending.name && node !== lookup && node !== remove,
  );
  requireSupportedSource(
    uses.length === 4 && other.length === 1,
    "OIDC evidence storage has an unverified reference",
  );
  checkSetter(other[0], verify);
}

/** Check the synchronous custody steps before deriving their Lean decision. */
export function checkEvidence(source) {
  const file = parseTypeScript(source, "claims.ts");
  const verify = functionSignature(
    file,
    "verifyNativeOidcProof",
    [["input", "VerifyNativeOidcInput"]],
    "Promise<NativeOidcProof>",
    { asynchronous: true },
  );
  const consume = functionSignature(
    file,
    "consumeNativeOidcProof",
    [["proof", "NativeOidcProof"]],
    null,
  );
  const statements = consume.body.statements;
  requireSupportedSource(statements.length === 6, "OIDC custody steps changed");
  const [lookupStatement, remove, absent, owner, expired, result] = statements;
  const value = declaration(lookupStatement);
  requireSupportedSource(
    pathIs(value.name, "value") &&
      !value.type &&
      callIs(value.initializer, ["pending", "get"], 1) &&
      pathIs(value.initializer.arguments[0], "proof") &&
      ts.isExpressionStatement(remove) &&
      callIs(remove.expression, ["pending", "delete"], 1) &&
      pathIs(remove.expression.arguments[0], "proof") &&
      ts.isExpressionStatement(owner) &&
      callIs(owner.expression, ["value", "owner", "assertCurrent"], 0) &&
      ts.isReturnStatement(result) &&
      pathIs(result.expression, "value"),
    "OIDC evidence must be deleted before validation and return",
  );
  checkRejections(absent, expired);
  checkPending(
    file,
    verify,
    value.initializer.expression.expression,
    remove.expression.expression.expression,
  );
}
