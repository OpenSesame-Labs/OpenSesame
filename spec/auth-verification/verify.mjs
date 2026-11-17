import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const lean = process.env.LEAN_BIN ?? "lean";
const names = [
  "CookieOrigin.decision_refines_policy",
  "CookieOrigin.unsafe_missing_origin_denied",
  "CookieOrigin.unsafe_empty_origin_denied",
  "CookieOrigin.unsafe_untrusted_origin_denied",
  "Session.decision_refines_policy",
  "Session.expired_denied",
  "Session.revoked_denied",
  "Session.suspended_denied",
  "OidcResponse.complete_refines_policy",
  "OidcResponse.complete_consumes",
  "OidcResponse.replay_never_exchanges",
  "OidcResponse.mismatched_state_never_exchanges",
].map((name) => `AuthAdmission.${name}`);
const allowedAxioms = new Set(["propext", "Quot.sound"]);

async function run(args, input) {
  const child = spawn(lean, args, {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`Lean failed:\n${stdout}${stderr}`);
  return stdout.trim();
}

const version = await run(["--short-version"]);
if (version !== "4.24.0")
  throw new Error(`Expected Lean 4.24.0, got ${version}`);
const source = readFileSync(join(directory, "AuthAdmission.lean"), "utf8");
const audit = readFileSync(join(directory, "Audit.lean"), "utf8");
const queries = names.map((name) => `#print axioms ${name}`).join("\n");
const report = await run(
  ["-E", "warning", "--stdin"],
  `${source}\n${audit}\n${queries}\n`,
);
const remaining = new Set(names);
for (const line of report.split("\n")) {
  const match = line.match(
    /^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$/,
  );
  if (!match || !remaining.delete(match[1]))
    throw new Error(`Unexpected Lean audit output: ${line}`);
  const axioms = match[2] ? match[2].split(", ").filter(Boolean) : [];
  const unknown = axioms.filter((axiom) => !allowedAxioms.has(axiom));
  if (unknown.length)
    throw new Error(
      `${match[1]} relies on unreviewed axioms: ${unknown.join(", ")}`,
    );
}
if (remaining.size)
  throw new Error(`Missing theorem audit: ${[...remaining].join(", ")}`);
const vectorsSource = readFileSync(
  join(directory, "DecisionVectors.lean"),
  "utf8",
);
const computed = JSON.parse(
  await run(["-E", "warning", "--stdin"], `${source}\n${vectorsSource}\n`),
);
const [cookie, session, oidc] = computed.split("|");
const saved = JSON.parse(
  readFileSync(join(directory, "decision-vectors.json"), "utf8"),
);
if (
  !/^[01]{16}$/.test(cookie) ||
  !/^[01]{240}$/.test(session) ||
  !/^[01]{128}$/.test(oidc) ||
  computed.split("|").length !== 3 ||
  Object.keys(saved).sort().join(",") !== "cookie,oidc,session" ||
  saved.cookie !== cookie ||
  saved.session !== session ||
  saved.oidc !== oidc
)
  throw new Error("Lean decision vectors differ from the tested vectors");
console.log(
  `Lean ${version}: checked ${names.length} named theorems, their axioms and decision vectors`,
);
