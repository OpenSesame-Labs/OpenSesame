import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSystemChromium,
  headlessShellCachePath,
  headlessShellInstallPlan,
  requiresHeadlessShell,
  resolveHeadlessShellBinary,
} from "./ensure-chrome-headless-shell.mjs";

const chromium = "/usr/bin/chromium";

test("requiresHeadlessShell is only the smoke flag", () => {
  assert.equal(
    requiresHeadlessShell({ CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL: "1" }),
    true,
  );
  assert.equal(
    requiresHeadlessShell({ CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL: "0" }),
    false,
  );
  assert.equal(requiresHeadlessShell({}), false);
});

test("system Chromium is used when the smoke flag is off", () => {
  const chosen = findSystemChromium({}, (path) => path === chromium);
  assert.equal(chosen, chromium);
});

test("smoke flag does not pick /usr/bin/chromium", () => {
  const env = {
    CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL: "1",
    PLAYWRIGHT_CHROMIUM: chromium,
  };
  assert.equal(
    findSystemChromium(env, () => true),
    null,
  );
  let installed = null;
  const resolved = resolveHeadlessShellBinary(
    { ...env, CD_CHROME_HEADLESS_CACHE: "/tmp/cd-chrome-missing" },
    (path) => path === chromium,
    (cacheRoot) => {
      installed = cacheRoot;
      return headlessShellCachePath(cacheRoot);
    },
  );
  assert.equal(installed, "/tmp/cd-chrome-missing");
  assert.match(resolved, /chrome-headless-shell$/);
  assert.notEqual(resolved, chromium);
});

test("smoke flag uses the cached chrome-headless-shell", () => {
  const cacheRoot = "/var/cache/cd-chrome-headless-shell";
  const cached = headlessShellCachePath(cacheRoot);
  const resolved = resolveHeadlessShellBinary(
    {
      CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL: "1",
      PLAYWRIGHT_CHROMIUM: chromium,
      CD_CHROME_HEADLESS_CACHE: cacheRoot,
    },
    (path) => path === chromium || path === cached,
    () => {
      throw new Error("cache hit must not download");
    },
  );
  assert.equal(resolved, cached);
});

test("installer stdout is suppressed", () => {
  const plan = headlessShellInstallPlan("/tmp/cd-chrome");
  assert.deepEqual(plan.stdio, ["ignore", "ignore", "inherit"]);
  assert.match(plan.args.join(" "), /chrome-headless-shell@156\.0\.8078\.4/);
  assert.equal(plan.command, "npx");
});
