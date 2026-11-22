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

const CLI_BOOKWORM_BUILD = /node:26-bookworm-slim@[\s\S]*AS build/;
const CLI_ALPINE_DIGEST =
  "node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";
const CLI_ALPINE_RUNTIME = new RegExp(CLI_ALPINE_DIGEST.replace("/", "\\/"));

const WEBPWA_BOOKWORM_BUILD = /node:26-bookworm-slim@[\s\S]*AS build/;
const WEBPWA_ALPINE_DIGEST =
  "node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";

describe("cli runtime image", () => {
  it("builds on bookworm-slim and serves on digest-pinned alpine", () => {
    expect(cliDockerfile).toMatch(CLI_BOOKWORM_BUILD);
    expect(cliDockerfile).toMatch(CLI_ALPINE_RUNTIME);
    const runtime = cliDockerfile.split(CLI_ALPINE_DIGEST)[1] ?? "";
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
    expect(webPwaDockerfile).toMatch(WEBPWA_BOOKWORM_BUILD);
    for (const block of webPwaDockerfile.split(/(?=FROM )/)) {
      if (!/AS runtime/.test(block) || !block.includes(WEBPWA_ALPINE_DIGEST))
        continue;
      expect(block).not.toMatch(/apt-get/);
      expect(block).toMatch(/adduser -D -u 10001 app/);
    }
  });
});
