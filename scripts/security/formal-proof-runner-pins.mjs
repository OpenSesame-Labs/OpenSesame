import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isString } from "../lib/json-boundary.mjs";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";

export const RUNNER_INVENTORY_PATH =
  "scripts/security/formal-proof-runner-pins.json";
const decoder = new TextDecoder("utf-8", { fatal: true });
const suiteId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const scriptName = /^verify:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const pathChars = /^[A-Za-z0-9._/-]+$/u;
const maxInventoryBytes = 256 * 1024;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const MINIMUM_SHARED_RUNNERS = Object.freeze([
  ".githooks/pre-push",
  ".npmrc",
  "scripts/security/formal-proof-push-gate.mjs",
  "scripts/security/formal-proof-push-gate-registry.mjs",
  "scripts/security/formal-proof-push-history.mjs",
  "scripts/security/formal-proof-lock-history.mjs",
  "scripts/security/formal-proof-manifest-set.mjs",
  "scripts/security/formal-proof-remote-main.mjs",
  "scripts/security/formal-proof-required-suites.mjs",
  "scripts/security/formal-proof-pinned-suites.mjs",
  "scripts/security/formal-proof-source-selection.mjs",
  "scripts/security/formal-proof-spiffe-peer-domain.mjs",
  "scripts/security/formal-proof-source-history.mjs",
  "scripts/security/formal-proof-runner-history.mjs",
  "scripts/security/formal-proof-runner-pins.mjs",
  RUNNER_INVENTORY_PATH,
  "scripts/lib/json-boundary.mjs",
  "spec/formal/check-axioms.sh",
  "spec/formal/required-theorem-command.lean",
]);
const cargoRunners = [
  "rust-toolchain.toml",
  "scripts/security/formal-cargo-isolation.py",
  "scripts/security/formal-cargo-freshness.py",
  "scripts/security/formal_cargo_packages.py",
  "scripts/security/cargo-lock-projection.py",
];
const workspaceRunners = [
  "scripts/security/cargo-workspace-projection.py",
  "scripts/security/cargo-workspace-multipackage.py",
];
const sourceSelectionRunners = [
  "spec/formal/source-trust-selection/verify.sh",
  "spec/formal/source-trust-selection/check-drift.py",
  "spec/formal/source-trust-selection/negative-controls.py",
  "spec/formal/source-trust-selection/test_drift.py",
  "spec/formal/source-trust-selection/test_snapshot.py",
  ...cargoRunners,
  ...workspaceRunners,
];
const suiteMinimums = {
  auth: [
    "scripts/test/auth-formal.sh",
    "scripts/test/auth-formal-drift.mjs",
    "scripts/test/formal-vitest-report.mjs",
    "spec/formal/auth/vitest.config.ts",
    "spec/formal/auth/negative-controls.py",
  ],
  oauth: [
    "spec/formal/oauth/verify.sh",
    "spec/formal/oauth/check-drift.mjs",
    "spec/formal/oauth/check-hosted-flow-report.mjs",
    "scripts/test/formal-vitest-report.mjs",
    "spec/formal/oauth/vitest.config.ts",
    "spec/formal/oauth/negative-controls.py",
    "spec/formal/oauth/hosted-flow-negative-controls.py",
  ],
  webauthn: [
    "spec/formal/webauthn/verify.sh",
    "spec/formal/webauthn/check-drift.mjs",
    "scripts/test/formal-vitest-report.mjs",
    "spec/formal/webauthn/vitest.config.ts",
    "spec/formal/webauthn/negative-controls.py",
  ],
  "interaction-clock": [
    "spec/formal/interaction-clock/verify.sh",
    "spec/formal/interaction-clock/check-drift.mjs",
    "spec/formal/interaction-clock/check-report.mjs",
    "scripts/test/formal-vitest-report.mjs",
    "spec/formal/interaction-clock/vitest.config.ts",
    "spec/formal/interaction-clock/negative-controls.py",
  ],
  authority: [
    "spec/formal/authority/check.sh",
    "spec/formal/authority/check-drift.py",
    "spec/formal/authority/negative-control.py",
    "spec/formal/authority/Cargo.toml",
    "spec/formal/authority/Cargo.lock",
    "scripts/security/cargo-workspace-projection.py",
    ...cargoRunners,
    "scripts/security/formal_coverage_drift.py",
  ],
  dpop: [
    "spec/formal/dpop/verify.sh",
    "spec/formal/dpop/check_drift.py",
    "spec/formal/dpop/mutate.py",
    "rust-toolchain.toml",
  ],
  spiffe: [
    "spec/formal/spiffe/verify.sh",
    "spec/formal/spiffe/check-drift.py",
    "spec/formal/spiffe/negative-controls.py",
    ...cargoRunners,
  ],
  "source-lifetime": [
    "spec/formal/source-lifetime/verify.sh",
    "spec/formal/source-lifetime/check-drift.py",
    "spec/formal/source-lifetime/negative-controls.py",
    ...cargoRunners,
  ],
  "source-trust-selection": sourceSelectionRunners,
  "spiffe-peer-domain": [
    "spec/formal/spiffe-peer-domain/verify.sh",
    "spec/formal/spiffe-peer-domain/check-drift.py",
    "spec/formal/spiffe-peer-domain/negative-controls.py",
    "spec/formal/spiffe-peer-domain/test_drift.py",
    ...cargoRunners,
    ...workspaceRunners,
  ],
  "nats-trust-rotation": [
    ...sourceSelectionRunners,
    "scripts/mtls/mtls-fixtures.sh",
    "ops/nats/local-dev.conf",
  ],
  "host-cli": [
    "spec/formal/host-cli/verify.sh",
    "rust-toolchain.toml",
    "scripts/security/formal-cargo-isolation.py",
  ],
  "source-history": [
    "spec/formal/source-trust-history/verify.sh",
    "spec/formal/source-trust-history/check-drift.py",
    "spec/formal/source-trust-history/negative-controls.py",
    ...cargoRunners,
    ...workspaceRunners,
  ],
};
const cargoSuites = new Set([
  "authority",
  "spiffe",
  "source-lifetime",
  "source-trust-selection",
  "spiffe-peer-domain",
  "nats-trust-rotation",
  "source-history",
  "host-cli",
]);

export function hasRunnerMinimum(id) {
  return Object.hasOwn(suiteMinimums, id);
}

export function minimumForSuite(suite) {
  const signatures = suite.proofs.filter((path) =>
    path.endsWith("/required-theorems.lean"),
  );
  if (signatures.length !== 1 || !hasRunnerMinimum(suite.id))
    throw new Error(
      `No independent formal runner minimum for suite ${suite.id}`,
    );
  const cargoConfigDirs = cargoSuites.has(suite.id) ? [".cargo"] : [];
  if (suite.id === "authority")
    cargoConfigDirs.push(
      "spec/.cargo",
      "spec/formal/.cargo",
      "spec/formal/authority/.cargo",
    );
  return {
    files: [...suiteMinimums[suite.id], ...signatures],
    cargoConfigDirs,
    optionalFiles:
      suite.id === "authority" ? ["spec/formal/authority/build.rs"] : [],
  };
}

function validPath(value) {
  return (
    isString(value) &&
    pathChars.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function checkedPaths(value, required = false) {
  if (
    !Array.isArray(value) ||
    (required && !value.length) ||
    value.some((path) => !validPath(path)) ||
    new Set(value).size !== value.length
  )
    throw new Error("Malformed formal runner inventory paths");
  return value;
}

function inventoryRows(bytes) {
  if (bytes.length > maxInventoryBytes)
    throw new Error("Formal runner inventory exceeds its size limit");
  let rows;
  try {
    rows = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Malformed formal runner inventory JSON");
  }
  if (
    !Array.isArray(rows) ||
    rows.length < 3 ||
    rows[0] !== "formal-proof-runners-v1" ||
    !Array.isArray(rows[1]) ||
    rows[1].length !== 2 ||
    rows[1][0] !== "shared"
  )
    throw new Error("Malformed formal runner inventory");
  return rows;
}

function addInventorySuite(suites, row) {
  if (!Array.isArray(row) || row.length !== 6 || row[0] !== "suite")
    throw new Error("Malformed formal runner inventory suite");
  const [, id, script, files, dirs, optional] = row;
  if (
    !isString(id) ||
    !suiteId.test(id) ||
    !isString(script) ||
    !scriptName.test(script) ||
    Object.hasOwn(suites, id)
  )
    throw new Error("Malformed or duplicate formal runner inventory suite");
  suites[id] = {
    script,
    files: checkedPaths(files, true),
    cargoConfigDirs: checkedPaths(dirs),
    optionalFiles: checkedPaths(optional),
  };
}

export function parseRunnerInventory(bytes) {
  const rows = inventoryRows(bytes);
  const shared = checkedPaths(rows[1][1], true);
  const suites = Object.create(null);
  for (const row of rows.slice(2)) addInventorySuite(suites, row);
  return { shared, suites };
}

function requireEntries(actual, required, label) {
  if (!required.every((path) => actual.includes(path)))
    throw new Error(`Formal runner inventory lacks required ${label}`);
}

export function validateRunnerMinimums(
  inventory,
  contracts = PINNED_FORMAL_SUITES,
) {
  const formal = contracts.filter(
    (suite) =>
      hasRunnerMinimum(suite.id) ||
      suite.proofs.some((path) => path.endsWith("/required-theorems.lean")),
  );
  if (!formal.length) return inventory;
  requireEntries(inventory.shared, MINIMUM_SHARED_RUNNERS, "shared runners");
  for (const suite of formal) {
    const minimum = minimumForSuite(suite);
    const runner = inventory.suites[suite.id];
    if (!runner || runner.script !== suite.command[2])
      throw new Error(
        `Formal runner inventory lacks required suite ${suite.id}`,
      );
    requireEntries(runner.files, minimum.files, `files for ${suite.id}`);
    requireEntries(
      runner.cargoConfigDirs,
      minimum.cargoConfigDirs,
      `Cargo directories for ${suite.id}`,
    );
    requireEntries(
      runner.optionalFiles,
      minimum.optionalFiles,
      `optional files for ${suite.id}`,
    );
  }
  return inventory;
}

function matchesStat(stat, mode, size) {
  const actualMode = stat.mode & 0o111 ? "100755" : "100644";
  return stat.isFile() && actualMode === mode && stat.size === size;
}

function boundedRead(fd, size) {
  const data = Buffer.allocUnsafe(size + 1);
  let length = 0;
  while (length < data.length) {
    const count = readSync(fd, data, length, data.length - length, null);
    if (!count) break;
    length += count;
  }
  return length === size ? data.subarray(0, length) : null;
}

function worktreeMatches(root, mode, bytes) {
  let current = root;
  const parts = RUNNER_INVENTORY_PATH.split("/");
  try {
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      const stat = lstatSync(current);
      if (index < parts.length - 1) {
        if (!stat.isDirectory()) return false;
      } else if (!matchesStat(stat, mode, bytes.length)) return false;
    }
    const fd = openSync(
      current,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!matchesStat(fstatSync(fd), mode, bytes.length)) return false;
      const data = boundedRead(fd, bytes.length);
      return data?.equals(bytes) ?? false;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function inventoryAt(root, revision, git) {
  const listing = decoder.decode(
    git(root, ["ls-tree", "-z", revision, "--", RUNNER_INVENTORY_PATH]),
  );
  const match =
    /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(
      listing,
    );
  if (!match || match[3] !== RUNNER_INVENTORY_PATH)
    throw new Error("Formal runner inventory is missing or not a regular file");
  const sizeText = decoder.decode(git(root, ["cat-file", "-s", match[2]]));
  if (!/^(?:0|[1-9][0-9]*)\n$/u.test(sizeText))
    throw new Error("Malformed formal runner inventory size");
  const size = Number(sizeText.trim());
  if (!Number.isSafeInteger(size) || size > maxInventoryBytes)
    throw new Error("Formal runner inventory exceeds its size limit");
  const bytes = git(root, ["cat-file", "blob", match[2]]);
  if (bytes.length !== size)
    throw new Error("Formal runner inventory blob size mismatch");
  return { mode: match[1], bytes };
}

export function validateRunnerInventory(root, revision, git) {
  return validateRunnerMinimums(
    parseRunnerInventory(inventoryAt(root, revision, git).bytes),
  );
}

export function validateRunnerInventoryHistory(root, change, git) {
  const output = git(root, [
    "log",
    "--format=%H",
    "--no-patch",
    "--full-history",
    "--diff-merges=separate",
    "--root",
    change.target,
    ...change.bases.map((oid) => `^${oid}`),
    "--",
    RUNNER_INVENTORY_PATH,
  ]);
  const revisions = [
    ...new Set(decoder.decode(output).split("\n").filter(Boolean)),
  ];
  if (revisions.some((oid) => !objectId.test(oid)))
    throw new Error("Malformed formal runner inventory history");
  for (const revision of revisions)
    validateRunnerMinimums(
      parseRunnerInventory(inventoryAt(root, revision, git).bytes),
    );
  return validateRunnerInventory(root, change.target, git);
}

export function loadRunnerInventory(root, head, git) {
  if (!head)
    throw new Error("Formal runner inventory requires a committed HEAD");
  const { mode, bytes } = inventoryAt(root, head, git);
  if (!worktreeMatches(root, mode, bytes))
    throw new Error(
      "Formal runner inventory differs from committed HEAD or is not a regular file",
    );
  return validateRunnerMinimums(parseRunnerInventory(bytes));
}

export function runnerFor(suite, inventory) {
  const runner = inventory.suites[suite.id];
  if (!runner || runner.script !== suite.command[2])
    throw new Error(`No pinned formal runner for suite ${suite.id}`);
  return { ...runner, files: [...runner.files, RUNNER_INVENTORY_PATH] };
}
