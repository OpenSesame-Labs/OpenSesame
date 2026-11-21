import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractModuleSpecifiers,
  readWebAuthnBrowserInputs,
  readWebAuthnImportClosure,
  renderWebAuthnBrowserEntry,
  validateWebAuthnBrowserSource,
  webAuthnBrowserEntry,
  webAuthnPinnedPaths,
} from "./webauthn-browser-entry.mjs";

const input = readWebAuthnBrowserInputs();

test("the pins cover exactly the static import closure of the verification leaves", () => {
  const closure = readWebAuthnImportClosure(input.packageRoot);
  const pinned = new Set(webAuthnPinnedPaths);
  const unpinned = closure.filter((relativePath) => !pinned.has(relativePath));
  assert.deepEqual(unpinned, []);
  const stale = webAuthnPinnedPaths.filter(
    (relativePath) =>
      relativePath !== "package.json" &&
      relativePath !== "esm/index.js" &&
      !closure.includes(relativePath),
  );
  assert.deepEqual(stale, []);
});

test("the import walker never trusts comments, strings, or dynamic imports", () => {
  const source = [
    '// import fake from "./fake-comment.js";',
    '/* export { fake } from "./fake-block.js"; */',
    'const doc = "import lies from \\"./fake-string.js\\";";',
    "const tpl = `export { x } from './fake-template.js'`;",
    'import("./fake-dynamic.js");',
    "import { real } from './real.js';",
    "export { other } from '../other.js';",
  ].join("\n");
  assert.deepEqual(extractModuleSpecifiers(source), [
    "./real.js",
    "../other.js",
  ]);
});

test("the browser entry retains the exact official verification functions", async () => {
  const source = renderWebAuthnBrowserEntry(input);
  assert.match(source, /verifyAuthenticationResponse/);
  assert.match(source, /verifyRegistrationResponse/);
  assert.doesNotMatch(source, /generateAuthenticationOptions|metadataService/);
  const official = await import("@simplewebauthn/server");
  const authentication = await import(
    input.sources["esm/authentication/verifyAuthenticationResponse.js"].path
  );
  const registration = await import(
    input.sources["esm/registration/verifyRegistrationResponse.js"].path
  );
  assert.equal(
    authentication.verifyAuthenticationResponse,
    official.verifyAuthenticationResponse,
  );
  assert.equal(
    registration.verifyRegistrationResponse,
    official.verifyRegistrationResponse,
  );
});

test("every reviewed SimpleWebAuthn input is content pinned", () => {
  assert.throws(
    () =>
      validateWebAuthnBrowserSource(
        "esm/index.js",
        `${input.sources["esm/index.js"].source}\n`,
      ),
    /pin mismatch/,
  );
  assert.doesNotThrow(() => readWebAuthnBrowserInputs());
});

test("the build plugin rewires only the owned browser seam", () => {
  const plugin = webAuthnBrowserEntry();
  plugin.buildStart();
  const seam = input.packageRoot.replace(
    /node_modules\/@simplewebauthn\/server$/,
    "packages/auth-upstream/src/simplewebauthn.ts",
  );
  assert.match(plugin.resolveId("@simplewebauthn/server", seam), /webauthn/);
  assert.equal(
    plugin.resolveId("@simplewebauthn/server", "/fixture/other.ts"),
    null,
  );
  assert.match(
    plugin.load("\0opensesame-simplewebauthn-browser"),
    /verifyRegistrationResponse/,
  );
});
