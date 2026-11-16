import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jar = process.env.TLA2TOOLS_JAR;
if (!jar)
  throw new Error(
    "Set TLA2TOOLS_JAR to the pinned TLC 1.7.4 jar; see spec/ui-behavior/README.md",
  );
const digest = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (
  digest !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
) {
  throw new Error(
    "TLA2TOOLS_JAR does not match the reviewed TLC 1.7.4 release",
  );
}
const model = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../spec/ui-behavior",
);
const metadata = mkdtempSync(join(tmpdir(), "opensesame-tlc-"));
try {
  const result = spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      resolve(jar),
      "tlc2.TLC",
      "-metadir",
      metadata,
      "-config",
      "ConnectorModes.cfg",
      "ConnectorModes.tla",
    ],
    { cwd: model, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(metadata, { recursive: true, force: true });
}
