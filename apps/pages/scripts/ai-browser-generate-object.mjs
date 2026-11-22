import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const facade = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/lib/command-bar/interpret-generate-object.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const caller = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/lib/command-bar/interpret.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const implementation = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/lib/command-bar/browser-generate-object.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const virtual = "\0opensesame-browser-generate-object";
const hashes = Object.freeze({
  [facade]: "de06516dad69aea60d261d3a763bd9b231b52cdb3e9c9afd8eb56da2c418f3f4",
  [caller]: "09ab63db71f532639a1990d9829ffee47339e055d2c61da4db224002114b9194",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateAiBrowserBoundary(path, source) {
  if (digest(source) !== hashes[path])
    throw new Error(`AI browser generateObject source pin mismatch: ${path}`);
}

export function readAiBrowserBoundary() {
  for (const path of [facade, caller])
    validateAiBrowserBoundary(path, readFileSync(path, "utf8"));
  return { caller, facade, implementation };
}

/** Keep the full SDK in tests; production's one pinned Prompt call uses its exact subset. */
export function aiBrowserGenerateObject() {
  let input;
  let resolved = 0;
  return {
    name: "opensesame-ai-browser-generate-object",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readAiBrowserBoundary();
      resolved = 0;
    },
    resolveId(source, importer) {
      if (!input)
        throw new Error("AI browser generateObject was not initialized");
      if (source !== "ai" || importer?.replaceAll("\\", "/") !== input.facade)
        return null;
      resolved += 1;
      return virtual;
    },
    load(id) {
      if (!input)
        throw new Error("AI browser generateObject was not initialized");
      return id === virtual
        ? `export { generateObject } from ${JSON.stringify(input.implementation)};`
        : null;
    },
    generateBundle() {
      if (!input)
        throw new Error("AI browser generateObject was not initialized");
      const ids = [...this.getModuleIds()].map((id) =>
        id.replaceAll("\\", "/"),
      );
      if (!ids.includes(input.facade)) return;
      if (
        resolved !== 1 ||
        !ids.includes(virtual) ||
        !ids.includes(input.implementation)
      )
        throw new Error(
          "AI browser generateObject boundary was not retained exactly once",
        );
      if (
        ids.some((id) =>
          /\/node_modules\/(?:ai|@ai-sdk\/(?:gateway|provider-utils))\//.test(
            id,
          ),
        )
      )
        throw new Error(
          "AI browser build retained the full generateObject SDK",
        );
    },
  };
}

export const aiBrowserBoundaryPaths = Object.freeze({
  caller,
  facade,
  implementation,
  virtual,
});
