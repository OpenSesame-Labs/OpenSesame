import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";
import {
  assertProofFiles,
  parseRegistry,
} from "./formal-proof-push-gate-registry.mjs";
import {
  assertPinnedRequirements,
  assertRequiredRegistry,
  parseRequirements,
  registryPath,
  requirementsPath,
} from "./formal-proof-required-suites.mjs";

// The push gate proves policy self-consistency while a push is being made.
// These checks catch inconsistent bindings earlier: projections that cannot
// see the crates a suite maps, missing projections for multi-package suites,
// and commands that execute a borrowed proof harness that the suite does not
// bind as a proof input.
const root = resolve(import.meta.dirname, "../..");

const proofPath = /^spec\/formal\/([a-z0-9-]+)\/[A-Za-z0-9._-]+$/u;
const scriptPathPattern = /spec\/formal\/[a-z0-9-]+\/[A-Za-z0-9._-]+/gu;

// Cargo facts come from the reviewed lock-projection helper the push gate
// itself executes; this gate never reimplements lockfile parsing.
const cargoFacts = `
import importlib.util, json, sys, tomllib
from pathlib import Path

root = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location(
    "cargo_lock_projection", root / "scripts/security/cargo-lock-projection.py"
)
projection = importlib.util.module_from_spec(spec)
sys.modules["cargo_lock_projection"] = projection
spec.loader.exec_module(projection)

workspace = tomllib.loads((root / "Cargo.toml").read_text())
packages = {}
for member in workspace.get("workspace", {}).get("members", []):
    found = (
        sorted(root.glob(member))
        if any(ch in member for ch in "*?[")
        else [root / member]
    )
    for directory in found:
        manifest = directory / "Cargo.toml"
        if not manifest.is_file():
            continue
        name = tomllib.loads(manifest.read_text()).get("package", {}).get("name")
        if name:
            packages[directory.relative_to(root).as_posix()] = {
                "name": name,
                "vendored": False,
            }
for patched in workspace.get("patch", {}).get("crates-io", {}).values():
    if not patched.get("path"):
        continue
    directory = root / patched["path"]
    if not (directory / "Cargo.toml").is_file():
        continue
    name = tomllib.loads((directory / "Cargo.toml").read_text())
    name = name.get("package", {}).get("name")
    if name:
        packages[directory.relative_to(root).as_posix()] = {
            "name": name,
            "vendored": True,
        }


def owner(path):
    best = None
    for directory in packages:
        if path == directory or path.startswith(directory + "/"):
            if best is None or len(directory) > len(best):
                best = directory
    return best


registry = json.loads((root / "spec/formal/proof-registry.json").read_text())
roots = sorted(
    {
        suite["lockProjection"]["root"]
        for suite in registry["suites"]
        if suite.get("lockProjection")
    }
)
graph = projection.read_lock(root / "Cargo.lock")
closures = {
    review_root: sorted({node.name for node, _, _ in graph.projection(review_root)})
    for review_root in roots
}
referenced = {}
for suite in registry["suites"]:
    names = set()
    for path in suite["implementation"]:
        directory = owner(path)
        if directory:
            names.add(packages[directory]["name"])
    referenced[suite["id"]] = sorted(names)
print(
    json.dumps(
        {
            "packages": packages,
            "closures": closures,
            "referenced": referenced,
        }
    )
)
`;

function reviewedCargoFacts() {
  const result = spawnSync("python3", ["-I", "-c", cargoFacts, root], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `reviewed cargo facts failed: ${result.stderr}${result.stdout}`,
  );
  return JSON.parse(result.stdout);
}

function ownerDirectory(facts, path) {
  let best = null;
  for (const directory of Object.keys(facts.packages))
    if (
      (path === directory || path.startsWith(`${directory}/`)) &&
      (best === null || directory.length > best.length)
    )
      best = directory;
  return best;
}

function referencedPackages(facts, suite) {
  const names = new Set();
  for (const path of suite.implementation) {
    const directory = ownerDirectory(facts, path);
    if (directory) names.add(facts.packages[directory].name);
  }
  return names;
}

function readRegistry() {
  return parseRegistry(readFileSync(resolve(root, registryPath)));
}

function npmScripts() {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
    .scripts;
}

test("registry, requirements, and the reviewed minimum agree", () => {
  const registry = readRegistry();
  const requirements = parseRequirements(
    readFileSync(resolve(root, requirementsPath)),
  );
  assertRequiredRegistry(registry, requirements);
  assertPinnedRequirements(requirements);
  assertRequiredRegistry(registry, { suites: PINNED_FORMAL_SUITES });
  const scripts = npmScripts();
  for (const suite of registry.suites) {
    assertProofFiles(root, suite);
    assert.equal(
      typeof scripts[suite.command[2]],
      "string",
      `${suite.id}: command npm run ${suite.command[2]} is not a root npm script`,
    );
  }
});

test("every mapped package is visible to the suite's lock projection", () => {
  const facts = reviewedCargoFacts();
  for (const suite of readRegistry().suites) {
    const projection = suite.lockProjection;
    if (!projection) continue;
    const closure = facts.closures[projection.root];
    assert.ok(
      closure,
      `${suite.id}: lock root ${projection.root} is absent from Cargo.lock`,
    );
    const unreachable = [...referencedPackages(facts, suite)].filter(
      (name) => !closure.includes(name),
    );
    assert.deepEqual(
      unreachable,
      [],
      `${suite.id}: implementation paths map to packages outside the ${projection.root} lock closure, so their dependency drift cannot select this proof`,
    );
  }
});

test("multi-package suites declare matching lock and manifest projections", () => {
  const facts = reviewedCargoFacts();
  for (const suite of readRegistry().suites) {
    const referenced = referencedPackages(facts, suite);
    const mapsVendoredPatch = suite.implementation.some((path) => {
      const directory = ownerDirectory(facts, path);
      return directory !== null && facts.packages[directory].vendored;
    });
    if (referenced.size < 2 && !mapsVendoredPatch) continue;
    const lock = suite.lockProjection;
    const manifest = suite.manifestProjection;
    assert.ok(
      lock,
      `${suite.id}: maps ${referenced.size} packages (${[...referenced].join(", ")}) without a lock projection`,
    );
    assert.ok(
      manifest,
      `${suite.id}: maps ${referenced.size} packages (${[...referenced].join(", ")}) without a manifest projection`,
    );
    assert.equal(
      manifest.root,
      lock.root,
      `${suite.id}: manifest projection root must match the lock projection root`,
    );
    const closure = facts.closures[lock.root];
    assert.ok(
      closure,
      `${suite.id}: lock root ${lock.root} is absent from Cargo.lock`,
    );
    for (const packagePath of [
      manifest.package,
      ...(manifest.manifests ?? []),
    ]) {
      assert.ok(
        suite.implementation.includes(packagePath),
        `${suite.id}: projected manifest ${packagePath} is not a mapped implementation path`,
      );
      const directory = ownerDirectory(facts, packagePath);
      assert.ok(
        directory,
        `${suite.id}: projected manifest ${packagePath} is neither a workspace member nor a vendored patch`,
      );
      assert.ok(
        closure.includes(facts.packages[directory].name),
        `${suite.id}: projected manifest ${packagePath} resolves outside the ${lock.root} closure`,
      );
    }
  }
});

test("a suite that borrows another suite's proofs pins the shared harness", () => {
  const registry = readRegistry();
  const scripts = npmScripts();
  const byId = new Map(registry.suites.map((suite) => [suite.id, suite]));
  for (const suite of registry.suites) {
    const script = scripts[suite.command[2]];
    const executed = [...script.matchAll(scriptPathPattern)].map(
      (match) => match[0],
    );
    const borrowed = new Set();
    for (const proof of suite.proofs) {
      const directory = proofPath.exec(proof)?.[1];
      if (!directory || directory === suite.id) continue;
      const owning = byId.get(directory);
      if (!owning) continue;
      // Borrowing means reusing the owning suite's model in that directory,
      // not merely referencing an auxiliary file such as a pinned toolchain.
      const sharedModel = owning.proofs.some(
        (other) =>
          suite.proofs.includes(other) &&
          other.startsWith(`spec/formal/${directory}/`),
      );
      if (sharedModel) borrowed.add(directory);
    }
    for (const directory of borrowed) {
      assert.ok(
        executed.some((path) => path.startsWith(`spec/formal/${directory}/`)),
        `${suite.id}: command must exercise the borrowed proofs in spec/formal/${directory}`,
      );
      for (const path of executed)
        if (path.startsWith(`spec/formal/${directory}/`))
          assert.ok(
            suite.proofs.includes(path),
            `${suite.id}: command executes ${path} without binding it as a proof input`,
          );
      for (const name of [
        "check-drift.py",
        "check_drift.py",
        "coverage.json",
      ]) {
        const path = `spec/formal/${directory}/${name}`;
        if (existsSync(resolve(root, path)))
          assert.ok(
            suite.proofs.includes(path),
            `${suite.id}: borrowed harness ${path} is not bound as a proof input`,
          );
      }
    }
  }
});
