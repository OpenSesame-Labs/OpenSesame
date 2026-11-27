import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRoot } from "./lib/dependency-root.mjs";

const pagesPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const carrierPath = fileURLToPath(
  new URL("../src/modules/sharing.live/carriers/nats.ts", import.meta.url),
).replaceAll("\\", "/");
const coreVirtual = "\0opensesame-nats-core-browser";

const pins = Object.freeze({
  "package.json":
    "ad51ec0867784130f73b78cef790dce03a57e94544105c09c9f33e45f7aff3cd",
  "lib/mod.js":
    "e1114b482fe99f83df560b68281fe0262a1045a26d36e29676906e535e5b922e",
  "lib/internal_mod.js":
    "b64b328e0c41dc80261b6a9ffb54b2f1a6f1cadff1e119c8011e0328e045fbcf",
  "lib/ws_transport.js":
    "7d3928824f91a9881c628f6113a5ab030d848766502250e47a7cf02b304d1c6e",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateNatsBrowserSource(relativePath, source) {
  if (digest(source) !== pins[relativePath])
    throw new Error(`NATS browser entry pin mismatch: ${relativePath}`);
}

export function readNatsBrowserInputs() {
  const packageRoot = dependencyRoot(pagesPackage, "@nats-io/nats-core");
  const sources = Object.fromEntries(
    Object.keys(pins).map((relativePath) => {
      const path = join(packageRoot, relativePath).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      validateNatsBrowserSource(relativePath, source);
      return [relativePath, { path, source }];
    }),
  );
  const manifest = JSON.parse(sources["package.json"].source);
  if (manifest.name !== "@nats-io/nats-core" || manifest.version !== "3.5.0")
    throw new Error("NATS browser entry package pin mismatch");
  return Object.freeze({ packageRoot, sources });
}

function leaf(input, relativePath) {
  return JSON.stringify(input.sources[relativePath].path);
}

export function renderNatsBrowserCore(input) {
  return `import ws from ${leaf(input, "lib/ws_transport.js")};
export const wsconnect = ws.wsconnect;
`;
}

/** Use the exact upstream NATS leaves instead of its non-tree-shakeable CJS barrels. */
export function natsBrowserEntry() {
  let input;
  let coreResolved = 0;
  return {
    name: "opensesame-nats-browser-entry",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readNatsBrowserInputs();
      coreResolved = 0;
    },
    resolveId(source, importer) {
      if (!input) throw new Error("NATS browser entry was not initialized");
      const from = importer?.replaceAll("\\", "/");
      if (source === "@nats-io/nats-core" && from === carrierPath) {
        coreResolved += 1;
        return coreVirtual;
      }
      return null;
    },
    load(id) {
      if (!input) throw new Error("NATS browser entry was not initialized");
      if (id === coreVirtual) return renderNatsBrowserCore(input);
      return null;
    },
    generateBundle() {
      if (!input) throw new Error("NATS browser entry was not initialized");
      const ids = [...this.getModuleIds()].map((id) =>
        id.replaceAll("\\", "/"),
      );
      const carrierPresent = ids.includes(carrierPath);
      if (!carrierPresent) return;
      if (coreResolved !== 1)
        throw new Error(`NATS browser boundary mismatch: core=${coreResolved}`);
      for (const barrel of ["/lib/mod.js", "/lib/internal_mod.js"])
        if (ids.includes(`${input.packageRoot}${barrel}`))
          throw new Error(`NATS browser build retained ${barrel}`);
      if (!ids.includes(coreVirtual))
        throw new Error(`NATS browser build lost ${coreVirtual}`);
    },
  };
}
