import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRoot } from "./lib/dependency-root.mjs";

const pagesPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const seamPath = fileURLToPath(
  new URL(
    "../../../packages/auth-upstream/src/simplewebauthn.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const virtualId = "\0opensesame-simplewebauthn-browser";

const pins = Object.freeze({
  "package.json":
    "2ecc3776356abc3180e27f16fd32b3680daaa68183f9716533d086dd326e903b",
  "esm/index.js":
    "eb81c4ce867adf3f51feea07eea2c1721373e4f0182eaaca00a402dec31b4ad9",
  "esm/authentication/verifyAuthenticationResponse.js":
    "f81ad465889e3bef9931191f3dbcb1f786828a8baf7571242c8889c65e373278",
  "esm/registration/verifyRegistrationResponse.js":
    "50e8d2e162f479841c3b1acca693d73ab53cdef0234520d4626366ff934761db",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateWebAuthnBrowserSource(relativePath, source) {
  if (digest(source) !== pins[relativePath]) {
    throw new Error(`WebAuthn browser entry pin mismatch: ${relativePath}`);
  }
}

export function readWebAuthnBrowserInputs() {
  const packageRoot = dependencyRoot(pagesPackage, "@simplewebauthn/server");
  const sources = Object.fromEntries(
    Object.keys(pins).map((relativePath) => {
      const path = join(packageRoot, relativePath).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      validateWebAuthnBrowserSource(relativePath, source);
      return [relativePath, { path, source }];
    }),
  );
  const manifest = JSON.parse(sources["package.json"].source);
  if (
    manifest.name !== "@simplewebauthn/server" ||
    manifest.version !== "14.1.0"
  ) {
    throw new Error("WebAuthn browser entry package pin mismatch");
  }
  return Object.freeze({ packageRoot, sources });
}

export function renderWebAuthnBrowserEntry(input) {
  const authentication =
    input.sources["esm/authentication/verifyAuthenticationResponse.js"].path;
  const registration =
    input.sources["esm/registration/verifyRegistrationResponse.js"].path;
  return `export { verifyAuthenticationResponse } from ${JSON.stringify(authentication)};
export { verifyRegistrationResponse } from ${JSON.stringify(registration)};
`;
}

/** Keep the official verification leaves without the side-effectful server barrel. */
export function webAuthnBrowserEntry() {
  let input;
  let resolved = 0;
  return {
    name: "opensesame-webauthn-browser-entry",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readWebAuthnBrowserInputs();
      resolved = 0;
    },
    resolveId(source, importer) {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      if (source === virtualId) return virtualId;
      if (
        source === "@simplewebauthn/server" &&
        importer?.replaceAll("\\", "/") === seamPath
      ) {
        resolved += 1;
        return virtualId;
      }
      return null;
    },
    load(id) {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      return id === virtualId ? renderWebAuthnBrowserEntry(input) : null;
    },
    generateBundle() {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      const ids = [...this.getModuleIds()].map((id) =>
        id.replaceAll("\\", "/"),
      );
      if (!ids.includes(seamPath)) return;
      if (resolved !== 1) {
        throw new Error(`WebAuthn browser boundary mismatch: seam=${resolved}`);
      }
      if (!ids.includes(virtualId)) {
        throw new Error(
          "WebAuthn browser build lost its verification boundary",
        );
      }
      if (ids.includes(input.sources["esm/index.js"].path)) {
        throw new Error("WebAuthn browser build retained the server barrel");
      }
    },
  };
}
