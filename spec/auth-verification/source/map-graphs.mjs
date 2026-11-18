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

/** The domain is checked against the actual exported TypeScript union. */
export const graphSpecs = [
  {
    key: "device",
    name: "Device",
    file: "device-auth.ts",
    type: "DeviceAuthorizationState",
    fn: "canTransitionDeviceAuth",
    states: ["pending", "approved", "denied", "expired", "consumed"],
  },
  {
    key: "claim",
    name: "Claim",
    file: "claim.ts",
    type: "ClaimState",
    fn: "canTransitionClaim",
    states: [
      "pending",
      "presented",
      "authenticated",
      "reviewed",
      "completed",
      "denied",
      "revoked",
      "expired",
    ],
  },
  {
    key: "agent",
    name: "Agent",
    file: "agent-registration.ts",
    type: "AgentRegistrationStatus",
    fn: "canTransitionAgentRegistration",
    states: ["unclaimed", "claim_pending", "claimed", "expired", "revoked"],
  },
  {
    key: "resource",
    name: "Resource",
    file: "provisional-resource.ts",
    type: "ResourceState",
    fn: "canTransitionResource",
    states: [
      "provisional",
      "active",
      "expired",
      "deleting",
      "deleted",
      "quarantined",
    ],
  },
];

function checkType(source, spec) {
  const file = parseTypeScript(source, "types.ts");
  const alias = namedStatement(file, ts.isTypeAliasDeclaration, spec.type);
  requireSupportedSource(
    ts.isUnionTypeNode(alias.type),
    "state domain changed",
  );
  const values = alias.type.types.map((member) => {
    requireSupportedSource(
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
      "state domain has nonliteral member",
    );
    return member.literal.text;
  });
  requireSupportedSource(
    values.length === spec.states.length &&
      new Set(values).size === spec.states.length &&
      spec.states.every((value) => values.includes(value)),
    `${spec.type} domain changed`,
  );
}

function checkImport(file, type) {
  const matches = file.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "../types.js" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      return [];
    return statement.importClause.namedBindings.elements.filter(
      (element) =>
        element.name.text === type &&
        !element.propertyName &&
        (element.isTypeOnly || statement.importClause.isTypeOnly),
    );
  });
  requireSupportedSource(matches.length === 1, `${type} import changed`);
}

function literalSet(node, states) {
  requireSupportedSource(
    ts.isNewExpression(node) &&
      pathIs(node.expression, "Set") &&
      !node.typeArguments?.length &&
      node.arguments &&
      node.arguments.length <= 1,
    "transition targets are not a literal Set",
  );
  const array = node.arguments[0];
  if (!array) return [];
  requireSupportedSource(
    ts.isArrayLiteralExpression(array),
    "transition targets are not a literal array",
  );
  const values = array.elements.map((element) => {
    requireSupportedSource(
      ts.isStringLiteral(element) && states.includes(element.text),
      "unknown transition target",
    );
    return element.text;
  });
  requireSupportedSource(
    new Set(values).size === values.length,
    "duplicate edge",
  );
  return values;
}

function graphEntries(declaration, spec) {
  const initial = declaration.initializer;
  requireSupportedSource(
    initial &&
      ts.isNewExpression(initial) &&
      pathIs(initial.expression, "Map") &&
      !initial.typeArguments?.length &&
      initial.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(initial.arguments[0]),
    "transition graph is not a literal Map",
  );
  const entries = new Map();
  for (const entry of initial.arguments[0].elements) {
    requireSupportedSource(
      ts.isArrayLiteralExpression(entry) &&
        entry.elements.length === 2 &&
        ts.isStringLiteral(entry.elements[0]) &&
        spec.states.includes(entry.elements[0].text) &&
        !entries.has(entry.elements[0].text),
      "unknown or repeated transition source",
    );
    entries.set(
      entry.elements[0].text,
      literalSet(entry.elements[1], spec.states),
    );
  }
  requireSupportedSource(
    entries.size === spec.states.length,
    "incomplete graph",
  );
  return entries;
}

function checkLookup(file, spec) {
  const fn = functionSignature(
    file,
    spec.fn,
    [
      ["from", spec.type],
      ["to", spec.type],
    ],
    "boolean",
  );
  requireSupportedSource(
    fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]) &&
      fn.body.statements[0].expression?.getText(file).replace(/\s+/g, "") ===
        "ALLOWED.get(from)?.has(to)??false" &&
      occurrences(file, "ALLOWED").length === 2 &&
      ["Map", "Set"].every(
        (name) => !occurrences(file, name).some(ts.isDeclarationName),
      ),
    "transition lookup or private graph use changed",
  );
}

/** Extract literal edges only after checking the real function and domain. */
export function extractMapGraph(source, types, spec) {
  checkType(types, spec);
  const file = parseTypeScript(source, spec.file);
  checkImport(file, spec.type);
  const entries = graphEntries(namedVariable(file, "ALLOWED"), spec);
  checkLookup(file, spec);
  const cases = [];
  for (const from of spec.states)
    for (const to of entries.get(from))
      cases.push(`  | .${from}, .${to} => true`);
  return `${cases.join("\n")}\n  | _, _ => false`;
}
