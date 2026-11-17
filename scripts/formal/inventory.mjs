import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLedger } from "./ledger.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ledger = JSON.parse(
  readFileSync(resolve(root, "spec/formal-verification/ledger.json"), "utf8"),
);
const errors = validateLedger(ledger, root);
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else if (process.argv.includes("--check")) {
  console.log(
    `Formal evidence ledger: ${ledger.behaviors.length} entries are structurally valid`,
  );
} else {
  // This inventory identifies source files, not state machines. File names and
  // textual signals are only leads for review and cannot prove completeness.
  const extensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".swift",
    ".kt",
    ".java",
    ".css",
    ".scss",
    ".html",
    ".xml",
    ".vue",
    ".svelte",
  ]);
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "crates",
      "packages",
      "marketplace",
      "tools",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const sources = [...new Set(names)]
    .filter(
      (name) =>
        extensions.has(extname(name)) &&
        existsSync(resolve(root, name)) &&
        !/(^|\/)(__tests__|tests?|fixtures?|node_modules|target|dist)\//.test(
          name,
        ) &&
        !/(\.test|\.spec|_test)\.[^.]+$/.test(name),
    )
    .sort();
  const referenced = new Set(
    ledger.behaviors.flatMap((entry) => entry.implementation),
  );
  const rows = sources.map((path) => {
    const content = readFileSync(resolve(root, path), "utf8");
    const signals = [];
    if (
      /\b(useState|useReducer|useSyncExternalStore|createMachine|stateMachine|reducer|transition)\b/i.test(
        content,
      )
    )
      signals.push("state");
    if (/\b(onClick|onChange|onKeyDown|onSubmit|onPointerDown)\b/.test(content))
      signals.push("ui-event");
    if (/auth|session|oauth|oidc|webauthn|saml|passkey|credential/i.test(path))
      signals.push("auth-path");
    return {
      path,
      signals,
      referencedBy: ledger.behaviors
        .filter((entry) => entry.implementation.includes(path))
        .map((entry) => entry.id),
    };
  });
  const report = {
    scope:
      "Tracked and untracked files in selected source languages under apps, crates, packages, marketplace and tools, excluding test and fixture paths; textual signals are review leads, not a complete state-machine inventory or proof coverage.",
    sources: rows.length,
    referencedSources: rows.filter((row) => referenced.has(row.path)).length,
    signaledSources: rows.filter((row) => row.signals.length).length,
    behaviors: ledger.behaviors.length,
    files: rows,
  };
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.scope);
    console.log(
      `Source files: ${report.sources}; with discovery signals: ${report.signaledSources}; referenced by ledger: ${report.referencedSources}; evidence entries: ${report.behaviors}.`,
    );
    console.log(
      "Use --json for paths and signals. An evidence reference does not mean the whole file is verified.",
    );
  }
}
