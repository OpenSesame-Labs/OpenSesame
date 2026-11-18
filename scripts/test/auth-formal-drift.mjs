import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/auth/coverage.json`, "utf8"),
);
const paths = [
  "packages/control-plane/src/middleware/auth.ts",
  "packages/control-plane/src/proofs/verified-principal.ts",
  "packages/control-plane/src/proofs/project-role.ts",
  "packages/control-plane/src/services/project-access.ts",
  "packages/os-domain/src/types.ts",
];
if (
  coverage.version !== 1 ||
  !/^[0-9a-f]{40}$/.test(coverage.reviewed_revision) ||
  !Array.isArray(coverage.sources) ||
  coverage.sources.length !== paths.length ||
  paths.some((path, index) => coverage.sources[index]?.path !== path)
) {
  throw new Error("auth-formal: invalid covered-source manifest");
}
for (const entry of coverage.sources) {
  let reviewed;
  try {
    reviewed = execFileSync(
      "git",
      ["show", `${coverage.reviewed_revision}:${entry.path}`],
      {
        cwd: root,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      },
    );
  } catch {
    throw new Error(
      `auth-formal: reviewed revision or source unavailable for ${entry.path}`,
    );
  }
  if (createHash("sha256").update(reviewed).digest("hex") !== entry.sha256) {
    throw new Error(
      `auth-formal: reviewed revision does not match ${entry.path}`,
    );
  }
  const digest = createHash("sha256")
    .update(readFileSync(`${root}/${entry.path}`))
    .digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(
      `auth-formal: source drift in ${entry.path}; review the model and update coverage.json`,
    );
  }
}
console.log(
  `auth-formal: covered sources match reviewed revision ${coverage.reviewed_revision}`,
);
