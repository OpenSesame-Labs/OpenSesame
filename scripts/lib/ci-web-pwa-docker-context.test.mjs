import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import ignore from "@balena/dockerignore";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

// quality:test loads this file with Vitest. The CD contract also runs under node --test.
const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
// Stand-in sha256 segments. nativeDistributionDirectory joins these two digests
// under .cache/pwa-tailscale-native-http/distributions.
const digest =
  "0000000000000000000000000000000000000000000000000000000000000000";
const probe = [
  ".cache/pwa-tailscale-native-http/distributions",
  digest,
  digest,
  ".docker-context-probe",
].join("/");

describe("web-pwa Docker context", () => {
  it("keeps a prepared Tailscale distribution marker in the repo-root context", () => {
    // Docker matches .dockerignore case-sensitively; the library default does not.
    const context = ignore({ ignorecase: false }).add(
      readFileSync(join(root, ".dockerignore"), "utf8"),
    );
    assert.equal(
      context.ignores(probe),
      false,
      `repo-root Docker context excludes ${probe}`,
    );
  });
});
