import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { simpleWebAuthnSeams } from "../simplewebauthn.js";

const require = createRequire(import.meta.url);

// The exports map blocks ./package.json, so locate the manifest by walking up
// from the resolved entry; this stays correct whether npm hoists the package
// to the workspace root or nests it under this package.
function installedServerVersion(): string {
  let dir = dirname(require.resolve("@simplewebauthn/server"));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === "@simplewebauthn/server") {
        return manifest.version ?? "";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("cannot locate @simplewebauthn/server package.json");
    }
    dir = parent;
  }
}

describe("simplewebauthn v14 surface", () => {
  it("executes against the installed @simplewebauthn/server 14.x", () => {
    expect(installedServerVersion()).toMatch(/^14\./);
  });

  it("exposes the v14 entry points the webauthn call sites use", () => {
    expect(typeof generateRegistrationOptions).toBe("function");
    expect(typeof generateAuthenticationOptions).toBe("function");
    expect(typeof verifyRegistrationResponse).toBe("function");
    expect(typeof verifyAuthenticationResponse).toBe("function");
  });

  it("binds the verification seam to exactly the installed v14 exports", () => {
    // src/passkey-verification.ts verifies ceremonies through these seams; if
    // the seam object drifts from the real exports, the production path stops
    // exercising the v14 surface this migration bumped to.
    expect(simpleWebAuthnSeams.verifyRegistrationResponse).toBe(
      verifyRegistrationResponse,
    );
    expect(simpleWebAuthnSeams.verifyAuthenticationResponse).toBe(
      verifyAuthenticationResponse,
    );
    expect(Object.keys(simpleWebAuthnSeams).sort()).toEqual([
      "verifyAuthenticationResponse",
      "verifyRegistrationResponse",
    ]);
  });
});
