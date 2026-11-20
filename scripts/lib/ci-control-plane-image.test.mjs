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
  });

  it("upgrades the slim runtime base before serving traffic", () => {
    const runtime =
      dockerfile.split("AS runtime-deps")[1]?.split("FROM")[1] ?? "";
    expect(runtime).toMatch(/apt-get -y upgrade --no-install-recommends/);
  });

  it("still starts from TypeScript sources with tsx", () => {
    expect(dockerfile).toMatch(
      /ENTRYPOINT \["node", "--import", "tsx", "packages\/control-plane\/src\/server\.ts"\]/,
    );
  });
});
