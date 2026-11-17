import ts from "@typescript/typescript6";

export { ts };

/** Preserve token boundaries and literal contents while ignoring trivia. */
export function sourceTokens(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const result = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  )
    result.push(`${kind}:${scanner.getTokenText()}`);
  return result.join("\n");
}

export function requireSupportedSource(condition, message) {
  if (!condition)
    throw new Error(`Unsupported authentication source: ${message}`);
}

export function parseTypeScript(source, name) {
  const file = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  requireSupportedSource(
    file.parseDiagnostics.length === 0,
    `${name} does not parse`,
  );
  return file;
}

export function namedStatement(file, predicate, name) {
  const matches = file.statements.filter(
    (statement) => predicate(statement) && statement.name?.text === name,
  );
  requireSupportedSource(
    matches.length === 1,
    `expected one ${name} declaration`,
  );
  return matches[0];
}

export function namedVariable(file, name) {
  const matches = file.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
          .filter(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === name,
          )
          .map((declaration) => ({ statement, declaration }))
      : [],
  );
  requireSupportedSource(matches.length === 1, `expected one ${name} variable`);
  const { statement, declaration } = matches[0];
  requireSupportedSource(
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.length === 1 &&
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    `${name} must be a private const`,
  );
  return declaration;
}

export function pathIs(node, ...segments) {
  if (!node || segments.length === 0) return false;
  if (segments.length === 1)
    return ts.isIdentifier(node) && node.text === segments[0];
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === segments.at(-1) &&
    pathIs(node.expression, ...segments.slice(0, -1))
  );
}

export function callIs(node, path, argumentCount) {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    !node.typeArguments?.length &&
    node.arguments.length === argumentCount &&
    pathIs(node.expression, ...path)
  );
}

export function occurrences(file, name) {
  const found = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function requireDirectFunctionUses(file, fn) {
  const uses = occurrences(file, fn.name.text);
  requireSupportedSource(
    uses.every(
      (node) =>
        node === fn.name ||
        (ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          !node.parent.questionDotToken),
    ),
    `${fn.name.text} has an unverified reference or reassignment`,
  );
}

function checkParameters(file, fn, name, params) {
  for (const [index, [paramName, type]] of params.entries()) {
    const parameter = fn.parameters[index];
    requireSupportedSource(
      ts.isIdentifier(parameter.name) &&
        parameter.name.text === paramName &&
        !parameter.questionToken &&
        !parameter.dotDotDotToken &&
        !parameter.initializer &&
        parameter.type?.getText(file).replace(/\s+/g, "") === type,
      `${name} parameter ${paramName} changed`,
    );
  }
}

export function functionSignature(
  file,
  name,
  params,
  result,
  { exported = true, asynchronous = false } = {},
) {
  const fn = namedStatement(file, ts.isFunctionDeclaration, name);
  const modifiers = fn.modifiers ?? [];
  requireSupportedSource(
    fn.body &&
      !fn.asteriskToken &&
      !fn.typeParameters?.length &&
      modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === exported &&
      modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) === asynchronous &&
      fn.parameters.length === params.length &&
      (result === null
        ? !fn.type
        : fn.type?.getText(file).replace(/\s+/g, "") === result),
    `${name} signature changed`,
  );
  checkParameters(file, fn, name, params);
  requireDirectFunctionUses(file, fn);
  return fn;
}
