import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { validateLedger } from "./ledger.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "formal-ledger-test-"));
  roots.push(root);
  mkdirSync(join(root, "spec/ui-behavior"), { recursive: true });
  writeFileSync(join(root, "implementation.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "spec/ui-behavior/Test.tla"), "Safe == TRUE\n");
  writeFileSync(
    join(root, "spec/ui-behavior/Test.cfg"),
    "SPECIFICATION Spec\nINVARIANTS\n  Safe\n",
  );
  const ledger = {
    schemaVersion: 1,
    behaviors: [
      {
        id: "test",
        claim: "A scoped claim",
        limits: "A clear limitation",
        implementation: ["implementation.ts"],
        evidence: [
          {
            kind: "model",
            path: "spec/ui-behavior/Test.tla",
            config: "spec/ui-behavior/Test.cfg",
            invariants: ["Safe"],
            scope: "Finite model",
          },
        ],
      },
    ],
  };
  return { root, ledger };
}

it("accepts a model entry whose listed invariant is configured and defined", () => {
  const { root, ledger } = fixture();
  assert.deepEqual(validateLedger(ledger, root), []);
});

it("rejects an unregistered model and missing evidence scope", () => {
  const { root, ledger } = fixture();
  writeFileSync(join(root, "spec/ui-behavior/Other.cfg"), "");
  mkdirSync(join(root, "spec/auth-verification"), { recursive: true });
  writeFileSync(join(root, "spec/auth-verification/Other.cfg"), "");
  ledger.behaviors[0].evidence[0].scope = "";
  const errors = validateLedger(ledger, root);
  assert.ok(
    errors.some((error) => error.includes("Unregistered model config")),
  );
  assert.ok(
    errors.some((error) => error.includes("spec/auth-verification/Other.cfg")),
  );
  assert.ok(errors.some((error) => error.includes("evidence scope")));
});

it("rejects an invariant omitted from the config, even if it appears elsewhere", () => {
  const { root, ledger } = fixture();
  writeFileSync(
    join(root, "spec/ui-behavior/Test.cfg"),
    "SPECIFICATION Spec\nCONSTANTS\n  Safe\n",
  );
  assert.ok(
    validateLedger(ledger, root).some((error) =>
      error.includes("invariants must match"),
    ),
  );
});

it("rejects a model entry pointing to a different configuration", () => {
  const { root, ledger } = fixture();
  writeFileSync(
    join(root, "spec/ui-behavior/Other.cfg"),
    "INVARIANTS\n  Safe\n",
  );
  ledger.behaviors[0].evidence[0].config = "spec/ui-behavior/Other.cfg";
  assert.ok(
    validateLedger(ledger, root).some((error) =>
      error.includes("matching pair"),
    ),
  );
});

it("rejects a missing implementation, duplicate behavior, and paths outside the repository", () => {
  const { root, ledger } = fixture();
  ledger.behaviors[0].implementation = ["../outside.ts", "missing.ts"];
  ledger.behaviors.push(ledger.behaviors[0]);
  const errors = validateLedger(ledger, root);
  assert.ok(errors.some((error) => error.includes("outside.ts")));
  assert.ok(errors.some((error) => error.includes("missing.ts")));
  assert.ok(errors.some((error) => error.includes("duplicate behavior")));
});
