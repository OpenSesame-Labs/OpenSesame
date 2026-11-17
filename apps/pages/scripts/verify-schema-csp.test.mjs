import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("cold schema verification requires the real blocking bootstrap before modules", () => {
  const dist = mkdtempSync(join(tmpdir(), "schema-csp-test-"));
  const script = fileURLToPath(
    new URL("./verify-schema-csp.mjs", import.meta.url),
  );
  const classic =
    '<script src="/OpenSesame/browser-schema-config.js"></script>';
  const module =
    '<script type="module" src="/OpenSesame/assets/main.js"></script>';
  const verify = () =>
    execFileSync(
      process.execPath,
      ["--experimental-vm-modules", script, dist],
      { stdio: "pipe" },
    );
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets/main.js"), "export {};\n");
    writeFileSync(
      join(dist, "capability-graph.json"),
      JSON.stringify({
        entries: [{ html: "index.html", scripts: ["assets/main.js"] }],
        workers: [],
      }),
    );
    writeFileSync(
      join(dist, "browser-schema-config.js"),
      "globalThis.__zod_globalConfig = { jitless: true };\n",
    );
    writeFileSync(join(dist, "index.html"), `${classic}${module}`);
    verify();
    writeFileSync(join(dist, "index.html"), `${module}${classic}`);
    assert.throws(verify);
    writeFileSync(
      join(dist, "index.html"),
      `${classic.replace("/OpenSesame/", "/other/")}${module}`,
    );
    assert.throws(verify);
    writeFileSync(join(dist, "index.html"), `${classic}${module}`);
    writeFileSync(
      join(dist, "browser-schema-config.js"),
      "globalThis.__zod_globalConfig = {};\n",
    );
    assert.throws(verify);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
