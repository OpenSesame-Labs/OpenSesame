import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isJsonObject } from "./json-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

/** The paths a manifest's `bin` field names, relative to the repository. */
function binPaths(manifest) {
  const { bin } = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  if (bin === undefined) return [];
  const entries = isJsonObject(bin) ? Object.values(bin) : [bin];
  return entries.map((entry) =>
    posix.normalize(posix.join(posix.dirname(manifest), entry)),
  );
}

/** The tracked mode of each tracked file among `paths`, by path. */
function trackedModes(paths) {
  const modes = new Map();
  for (const line of git("ls-files", "-s", "--", ...paths)) {
    const [, mode, path] = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(line) ?? [];
    if (path) modes.set(path, mode);
  }
  return modes;
}

describe("workspace bin targets", () => {
  // npm marks every bin target executable when it installs the workspace.
  // A target tracked without the executable bit is reported as modified
  // after every `npm ci`, and a gate that requires a clean checkout, such
  // as the weekly native WASM validation, refuses to start.
  it("are tracked as executable, so an install leaves the checkout clean", () => {
    const manifests = git("ls-files", "--", "package.json", "*/package.json");
    const modes = trackedModes(manifests.flatMap(binPaths));
    expect([...modes.keys()]).toContain("examples/agent/src/main.ts");
    expect(
      [...modes].filter(([, mode]) => mode !== "100755").map(([path]) => path),
    ).toStrictEqual([]);
  });
});
