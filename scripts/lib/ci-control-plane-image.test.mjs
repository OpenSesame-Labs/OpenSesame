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
    expect(dockerfile).toMatch(/COPY --from=build \/src\/patches \.\/patches/);
  });

  it("serves traffic from digest-pinned alpine without apt", () => {
    expect(dockerfile).toMatch(
      /node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5[\s\S]*AS runtime-deps/,
    );
    const afterDeps = dockerfile.split("AS runtime-deps")[1] ?? "";
    expect(afterDeps).toMatch(/adduser -D -u 10001 app/);
    expect(afterDeps).not.toMatch(/apt-get/);
  });

  it("still starts from TypeScript sources with tsx", () => {
    expect(dockerfile).toMatch(
      /ENTRYPOINT \["node", "--import", "tsx", "packages\/control-plane\/src\/server\.ts"\]/,
    );
  });
});
