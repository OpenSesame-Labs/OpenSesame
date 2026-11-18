import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const nonempty = (value) => text.safeParse(value).success;

function file(path, label, state) {
  if (!nonempty(path) || isAbsolute(path)) {
    state.errors.push(`${label} must be a repository-relative file`);
    return false;
  }
  const absolute = resolve(state.root, path);
  if (
    relative(state.root, absolute).startsWith("..") ||
    !existsSync(absolute) ||
    !statSync(absolute).isFile()
  ) {
    state.errors.push(`${label} does not exist inside the repository: ${path}`);
    return false;
  }
  return true;
}

function configuredInvariants(config) {
  const configured = [];
  let inInvariants = false;
  for (const raw of config.split("\n")) {
    const line = raw.split("\\*")[0].trim();
    if (/^INVARIANTS?$/.test(line)) {
      inInvariants = true;
      continue;
    }
    if (
      /^(SPECIFICATION|INIT|NEXT|CONSTANTS?|PROPERT(?:Y|IES)|CONSTRAINT|ACTION_CONSTRAINT|SYMMETRY|VIEW|CHECK_DEADLOCK)\b/.test(
        line,
      )
    ) {
      inInvariants = false;
    } else if (inInvariants && line) configured.push(line);
  }
  return configured;
}

function matchingPair(evidence) {
  return (
    evidence.path.endsWith(".tla") &&
    `${evidence.path.slice(0, -4)}.cfg` === evidence.config
  );
}

function checkModel(evidence, id, present, state) {
  const configPresent = file(evidence.config, `${id}: model config`, state);
  if (present && !matchingPair(evidence)) {
    state.errors.push(`${id}: model and config must be a matching pair`);
  }
  if (state.configs.has(evidence.config))
    state.errors.push(`${id}: duplicate model config ${evidence.config}`);
  state.configs.add(evidence.config);
  if (!Array.isArray(evidence.invariants) || !evidence.invariants.length) {
    state.errors.push(`${id}: list the configured invariants`);
    return;
  }
  if (!present || !configPresent) return;
  const model = readFileSync(resolve(state.root, evidence.path), "utf8");
  const configured = configuredInvariants(
    readFileSync(resolve(state.root, evidence.config), "utf8"),
  );
  if (
    new Set(evidence.invariants).size !== evidence.invariants.length ||
    configured.length !== evidence.invariants.length ||
    configured.some((name) => !evidence.invariants.includes(name))
  ) {
    state.errors.push(`${id}: ledger invariants must match the model config`);
  }
  for (const invariant of evidence.invariants) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(invariant)) {
      state.errors.push(`${id}: invalid invariant name ${invariant}`);
    } else if (
      !new RegExp(`^\\s*${invariant}\\s*==`, "m").test(model) ||
      !configured.includes(invariant)
    ) {
      state.errors.push(
        `${id}: invariant ${invariant} must occur in both model and config`,
      );
    }
  }
}

function checkBehavior(behavior, state) {
  const id = behavior.id;
  if (!nonempty(id) || state.ids.has(id))
    state.errors.push(`Invalid or duplicate behavior id: ${id}`);
  state.ids.add(id);
  if (!nonempty(behavior.claim) || !nonempty(behavior.limits)) {
    state.errors.push(`${id}: claim and limits are required`);
  }
  if (
    !Array.isArray(behavior.implementation) ||
    !behavior.implementation.length
  ) {
    state.errors.push(`${id}: at least one implementation file is required`);
  } else {
    for (const path of behavior.implementation)
      file(path, `${id}: implementation`, state);
  }
  if (!Array.isArray(behavior.evidence) || !behavior.evidence.length) {
    state.errors.push(`${id}: at least one evidence entry is required`);
    return;
  }
  for (const evidence of behavior.evidence) {
    if (!nonempty(evidence.scope))
      state.errors.push(`${id}: evidence scope is required`);
    if (
      ![
        "model",
        "property-test",
        "example-test",
        "browser-test",
        "proof",
      ].includes(evidence.kind)
    ) {
      state.errors.push(`${id}: unknown evidence kind ${evidence.kind}`);
    }
    const present = file(evidence.path, `${id}: evidence`, state);
    if (evidence.kind === "model") checkModel(evidence, id, present, state);
  }
}

function checkRegisteredModels(state) {
  const formalDir = resolve(state.root, "spec/formal-verification");
  if (existsSync(formalDir)) {
    for (const sub of readdirSync(formalDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    )) {
      const modelDir = resolve(formalDir, sub.name);
      for (const name of readdirSync(modelDir).filter((entry) =>
        entry.endsWith(".cfg"),
      )) {
        if (name.endsWith("Buggy.cfg")) continue;
        const path = `spec/formal-verification/${sub.name}/${name}`;
        if (!state.configs.has(path))
          state.errors.push(`Unregistered model config: ${path}`);
      }
    }
  }
  for (const directory of ["spec/ui-behavior", "spec/auth-verification"]) {
    const modelDir = resolve(state.root, directory);
    if (existsSync(modelDir)) {
      for (const name of readdirSync(modelDir).filter((entry) =>
        entry.endsWith(".cfg"),
      )) {
        const path = `${directory}/${name}`;
        if (!state.configs.has(path))
          state.errors.push(`Unregistered model config: ${path}`);
      }
    }
  }
}

// The ledger is an index of evidence, never a claim that a file is proved.
// Errors are returned together so a contributor can repair an entry in one pass.
export function validateLedger(ledger, root) {
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.behaviors)) {
    return ["Expected schemaVersion 1 and a behaviors array"];
  }
  const state = { root, errors: [], ids: new Set(), configs: new Set() };
  for (const behavior of ledger.behaviors) checkBehavior(behavior, state);
  checkRegisteredModels(state);
  return state.errors;
}
