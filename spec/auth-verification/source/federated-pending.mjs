import { readFileSync } from "node:fs";
import {
  functionSignature,
  namedStatement,
  namedVariable,
  parseTypeScript,
  requireSupportedSource,
  sourceTokens,
  ts,
} from "./ast.mjs";

const snapshot = parseTypeScript(
  readFileSync(
    new URL("./federated-pending-reviewed.txt", import.meta.url),
    "utf8",
  ),
  "federated-pending-reviewed.ts",
);
const names = [
  "legBindingMaterial",
  "verifierSealKey",
  "sealVerifier",
  "unsealVerifier",
  "pendingMac",
  "pendingFromWire",
  "base64urlJson",
  "parseWire",
  "encodePending",
  "decodePending",
];
const variables = [
  "pendingFederatedAuthSchema",
  "unsignedWireSchema",
  "sealedWireSchema",
  "MAX_PENDING_COOKIE_LENGTH",
  "MAC_KEY_LABEL",
  "MAC_DOMAIN",
  "defaultKeys",
];

export function checkFederatedPending(source) {
  const file = parseTypeScript(source, "federated-pending.ts");
  const imports = (input) =>
    input.statements
      .filter(ts.isImportDeclaration)
      .map((item) => sourceTokens(item.getText(input)));
  requireSupportedSource(
    imports(file).join("\n") === imports(snapshot).join("\n"),
    "federation cookie dependency bindings changed",
  );
  for (const name of variables) {
    const variable = namedVariable(file, name);
    const reviewed = namedVariable(snapshot, name);
    requireSupportedSource(
      sourceTokens(variable.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `federation cookie binding ${name} changed`,
    );
  }
  for (const name of names) {
    const fn = namedStatement(file, ts.isFunctionDeclaration, name);
    const reviewed = namedStatement(snapshot, ts.isFunctionDeclaration, name);
    requireSupportedSource(
      sourceTokens(fn.getText(file)) ===
        sourceTokens(reviewed.getText(snapshot)),
      `federation cookie function ${name} changed`,
    );
  }
}

/*
 * FED-I4 from the code: translate the body of the real `decodeSigned`
 * (federated-pending.ts) statement by statement into the instruction list
 * `PendingInstr` in Contracts.lean. Each guard, each step of work and the
 * accepting return is recognised by its exact tokens; anything else is
 * refused, so the generated program is the function's own statement order.
 * Lean then proves that order against the independent `pendingPolicy`.
 */

const tokens = (text) =>
  sourceTokens(text.trim().replace(/;$/, "").replace(/\s+/g, " "));

// `if (<condition>) return undefined;` -> the fact the condition requires.
const guards = new Map(
  [
    ["raw.length > MAX_PENDING_COOKIE_LENGTH", "withinCap"],
    ["split <= 0", "hasDot"],
    ["!/^[A-Za-z0-9_-]+$/.test(payload)", "alphabet"],
    ["supplied.length !== expected.length", "sameLength"],
    ["!timingSafeEqual(supplied, expected)", "macEqual"],
    ["wire === undefined", "sealedWire"],
    ["verifier === undefined", "sealOk"],
  ].map(([condition, fact]) => [tokens(condition), fact]),
);

// `const <name> = <initializer>;` -> the work it performs (null: none).
const bindings = new Map(
  [
    ['split = raw.lastIndexOf(".")', null],
    ["payload = raw.slice(0, split)", null],
    ['supplied = Buffer.from(raw.slice(split + 1), "base64url")', null],
    ["expected = pendingMac(payload, secret)", "mac"],
    ["wire = parseWire(sealedWireSchema, payload)", "parse"],
    ["{ verifierEnc, ...rest } = wire", null],
    ["key: Buffer", null],
    ["verifier = unsealVerifier(key, verifierEnc)", "unseal"],
  ].map(([binding, step]) => [tokens(binding), step]),
);

// A password hash anywhere in the body is translated, not refused, so the
// Lean theorem `pending_decode_no_slow_hash` is what rejects it.
const slowHashes = new Set([
  "scrypt",
  "scryptSync",
  "pbkdf2",
  "pbkdf2Sync",
  "argon2",
  "bcrypt",
]);

const returnsUndefined = (statement, file) =>
  ts.isReturnStatement(statement) &&
  statement.expression &&
  statement.expression.getText(file) === "undefined";

const single = (block) =>
  ts.isBlock(block) && block.statements.length === 1
    ? block.statements[0]
    : ts.isBlock(block)
      ? undefined
      : block;

function slowHashCall(declaration, file) {
  const init = declaration.initializer;
  return (
    init &&
    ts.isCallExpression(init) &&
    ts.isIdentifier(init.expression) &&
    slowHashes.has(init.expression.getText(file))
  );
}

function translateGuard(statement, file) {
  const fact = guards.get(tokens(statement.expression.getText(file)));
  const then = single(statement.thenStatement);
  requireSupportedSource(
    fact && !statement.elseStatement && then && returnsUndefined(then, file),
    `decodeSigned guard changed: ${statement.getText(file)}`,
  );
  return `.guard .${fact}`;
}

function translateBinding(statement, file) {
  const [declaration, ...more] = statement.declarationList.declarations;
  requireSupportedSource(
    more.length === 0,
    "decodeSigned declares several bindings",
  );
  if (slowHashCall(declaration, file)) return ".work .slowHash";
  const text = tokens(declaration.getText(file));
  requireSupportedSource(
    bindings.has(text),
    `decodeSigned binding changed: ${declaration.getText(file)}`,
  );
  const step = bindings.get(text);
  return step === null ? null : `.work .${step}`;
}

function translateDerivation(statement, file) {
  const body = single(statement.tryBlock);
  const handler = statement.catchClause;
  const derivation = tokens(
    "key = keys.verifierSealKey(secret, rest.state, rest.nonce)",
  );
  requireSupportedSource(
    body &&
      ts.isExpressionStatement(body) &&
      tokens(body.expression.getText(file)) === derivation &&
      handler &&
      !handler.variableDeclaration &&
      !statement.finallyBlock &&
      single(handler.block) &&
      returnsUndefined(single(handler.block), file),
    "decodeSigned key derivation changed",
  );
  return ".tryWork .deriveKey .legOk";
}

function translate(statement, file) {
  if (ts.isIfStatement(statement)) return translateGuard(statement, file);
  if (ts.isVariableStatement(statement))
    return translateBinding(statement, file);
  if (ts.isTryStatement(statement)) return translateDerivation(statement, file);
  requireSupportedSource(
    ts.isReturnStatement(statement) &&
      tokens(statement.expression?.getText(file) ?? "") ===
        tokens("pendingFromWire(rest, verifier)"),
    `decodeSigned statement unsupported: ${statement.getText(file)}`,
  );
  return ".accept";
}

/** Lean source for `extractedPendingDecode`, derived from `decodeSigned`. */
export function extractPendingDecode(source) {
  const file = parseTypeScript(source, "federated-pending.ts");
  const fn = functionSignature(
    file,
    "decodeSigned",
    [
      ["raw", "string"],
      ["secret", "string"],
      ["keys", "PendingCookieKeys"],
    ],
    "PendingFederatedAuth|undefined",
    { exported: false },
  );
  const program = fn.body.statements
    .map((statement) => translate(statement, file))
    .filter((instruction) => instruction !== null);
  requireSupportedSource(
    program.at(-1) === ".accept" &&
      program.filter((instruction) => instruction === ".accept").length === 1,
    "decodeSigned must end in its one accepting return",
  );
  return `[${program.join(", ")}]`;
}
