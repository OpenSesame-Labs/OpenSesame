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
    "8285aa1d8c0e681e72415b6c1e66fc74b9357bb05958336b817a144d02fa4b44",
  "esm/index.js":
    "de015f7f564190fa3433d6d115389c98a63489884a04c6eecf86d1c793571c63",
  "esm/authentication/verifyAuthenticationResponse.js":
    "31622302b14baca27db20b8cf3a5664eb9af8642ba47862370473f7890b6980b",
  "esm/registration/verifyRegistrationResponse.js":
    "e25ae978be3b14e4d8462d84924ceb93bf054692010409b52122bcdbf49d72b1",
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
    manifest.version !== "13.3.2"
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
