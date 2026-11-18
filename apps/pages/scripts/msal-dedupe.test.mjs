import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { test } from "vitest";
import { msalDedupe } from "./msal-dedupe.mjs";

const pages = fileURLToPath(new URL("..", import.meta.url));
const appCore = resolve(pages, "../../packages/app-core");

function manifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function owningPackage(file, name) {
  let directory = dirname(file);
  while (directory !== dirname(directory)) {
    try {
      const result = manifest(join(directory, "package.json"));
      if (result.name === name) return result;
    } catch {
      // Intermediate folders of a published package need no manifest.
    }
    directory = dirname(directory);
  }
  throw new Error(`No ${name} manifest contains ${file}`);
}

test("only identical exact workspace pins may share an MSAL SDK", () => {
  assert.deepEqual(msalDedupe("5.28.0", "5.28.0"), [
    "@azure/msal-browser",
    "@azure/msal-common",
  ]);
  assert.deepEqual(msalDedupe("5.28.0", "5.27.0"), []);
  assert.deepEqual(msalDedupe("^5.28.0", "^5.28.0"), []);
  assert.deepEqual(msalDedupe(undefined, undefined), []);
});

test("MSAL's browser SDK and bridge resolve one pinned copy in both workspaces", async () => {
  const config = await resolveConfig(
    {
      root: pages,
      configFile: join(pages, "vite.config.ts"),
      logLevel: "silent",
    },
    "build",
  );
  const resolveModule = config.createResolver();
  const importers = [
    join(pages, "auth/redirect-bridge.ts"),
    join(appCore, "src/lib/ambient-auth/entra.ts"),
  ];
  const pagesVersion = manifest(join(pages, "package.json")).dependencies[
    "@azure/msal-browser"
  ];
  const appCoreVersion = manifest(join(appCore, "package.json")).dependencies[
    "@azure/msal-browser"
  ];
  if (msalDedupe(pagesVersion, appCoreVersion).length === 0) {
    assert.equal(config.resolve.dedupe.includes("@azure/msal-browser"), false);
    assert.equal(config.resolve.dedupe.includes("@azure/msal-common"), false);
    return;
  }

  for (const [specifier, name] of [
    ["@azure/msal-browser", "@azure/msal-browser"],
    ["@azure/msal-browser/redirect-bridge", "@azure/msal-browser"],
    ["@azure/msal-common/browser", "@azure/msal-common"],
  ]) {
    const [bridge, runtime] = await Promise.all(
      importers.map((importer) => resolveModule(specifier, importer)),
    );
    assert.ok(bridge, `${specifier} resolved`);
    assert.equal(bridge, runtime, `${specifier} shares one physical module`);
    const owner = owningPackage(bridge, name);
    if (name === "@azure/msal-browser")
      assert.equal(owner.version, pagesVersion);
    else {
      const browser = await resolveModule("@azure/msal-browser", importers[0]);
      const dependency = owningPackage(browser, "@azure/msal-browser")
        .dependencies["@azure/msal-common"];
      assert.equal(owner.version, dependency);
    }
  }
});
