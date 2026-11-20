import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolveRoot();
const dockerfile = readFileSync(
  join(root, "ops/containers/control-plane/Dockerfile"),
  "utf8",
);

function resolveRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

describe("control-plane runtime image", () => {
  it("installs production dependencies only in the runtime-deps stage", () => {
    expect(dockerfile).toMatch(/AS runtime-deps/);
    expect(dockerfile).toMatch(
      /npm ci --omit=dev --ignore-scripts[\s\S]*tsx@4\.23\.15/,
    );
    expect(dockerfile).toMatch(
      /find node_modules -name '\.package-lock\.json' -delete/,
    );
    expect(dockerfile).toMatch(
      /rm -rf node_modules\/@typescript node_modules\/typescript/,
    );
    // No dev install anywhere: the retired Debian build stage paid for one
    // and discarded the result, which is what pushed proof builds past the
    // ten-minute cap (docs/operators/ghcr-images.md).
    expect(dockerfile).not.toMatch(/npm ci --ignore-scripts/);
    expect(dockerfile).not.toMatch(/AS build\b/);
  });

  it("keys dependency layers on npm manifests, not on sources", () => {
    expect(dockerfile).toMatch(/AS manifests/);
    expect(dockerfile).toMatch(/COPY --from=manifests \/src \.\//);
    // The prune keeps only what `npm ci` reads: root manifests, patches for
    // patchedDependencies, the five workspace roots, and every workspace
    // package.json. The inner prune runs first; the root prune would delete
    // the workspace roots outright.
    expect(dockerfile).toMatch(
      /find apps packages examples tests tools -type f ! -name package\.json -delete/,
    );
    expect(dockerfile).toMatch(
      /find \. -mindepth 1 -maxdepth 1[\s\S]*! -name patches[\s\S]*-exec rm -rf -- \{\} \+/,
    );
    const inner = dockerfile.indexOf(
      "find apps packages examples tests tools -type f",
    );
    const root = dockerfile.indexOf("find . -mindepth 1 -maxdepth 1");
    expect(inner).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(inner);
    // Sources land after the install so editing them cannot invalidate the
    // dependency layers a warm proof run is expected to reuse.
    const install = dockerfile.indexOf("npm ci --omit=dev");
    const sources = dockerfile.indexOf("COPY packages ./packages");
    expect(install).toBeGreaterThan(-1);
    expect(sources).toBeGreaterThan(install);
  });

  it("serves traffic from digest-pinned alpine without apt", () => {
    expect(dockerfile).toMatch(
      /node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5[\s\S]*AS runtime-deps/,
    );
    const afterDeps = dockerfile.split("AS runtime-deps")[1] ?? "";
    expect(afterDeps).toMatch(/adduser -D -u 10001 app/);
    expect(afterDeps).not.toMatch(/apt-get/);
    expect(dockerfile).not.toMatch(/apt-get|bookworm/);
  });

  it("still starts from TypeScript sources with tsx", () => {
    expect(dockerfile).toMatch(
      /ENTRYPOINT \["node", "--import", "tsx", "packages\/control-plane\/src\/server\.ts"\]/,
    );
  });
});
