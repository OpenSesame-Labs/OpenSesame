import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliDockerfile = readFileSync(
  join(root, "ops/containers/cli/Dockerfile"),
  "utf8",
);
const webPwaDockerfile = readFileSync(
  join(root, "ops/containers/web-pwa/Dockerfile"),
  "utf8",
);

const ALPINE_DIGEST =
  "node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";
const ALPINE_RUNTIME = new RegExp(ALPINE_DIGEST.replace("/", "\\/"));

describe("cli runtime image", () => {
  it("builds on bookworm-slim and serves on digest-pinned alpine", () => {
    expect(cliDockerfile).toMatch(/node:24-bookworm-slim@[\s\S]*AS build/);
    expect(cliDockerfile).toMatch(ALPINE_RUNTIME);
    const runtime = cliDockerfile.split(ALPINE_DIGEST)[1] ?? "";
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime).not.toMatch(/apt-get/);
    expect(runtime).toMatch(/adduser -D -u 10001 app/);
  });

  it("strips nested lockfiles and typescript after production install", () => {
    expect(cliDockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(cliDockerfile).toMatch(
      /find node_modules -name '\.package-lock\.json' -delete/,
    );
    expect(cliDockerfile).toMatch(
      /rm -rf node_modules\/@typescript node_modules\/typescript/,
    );
  });
});

describe("web-pwa runtime image", () => {
  it("builds on bookworm-slim and serves on digest-pinned alpine", () => {
    expect(webPwaDockerfile).toMatch(/node:24-bookworm-slim@[\s\S]*AS build/);
    for (const block of webPwaDockerfile.split(/(?=FROM )/)) {
      if (!/AS runtime/.test(block) || !block.includes(ALPINE_DIGEST)) continue;
      expect(block).not.toMatch(/apt-get/);
      expect(block).toMatch(/adduser -D -u 10001 app/);
    }
  });
});
