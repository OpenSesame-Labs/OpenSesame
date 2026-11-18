import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRoot } from "./lib/dependency-root.mjs";

const pagesPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const transportPath = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/tutorial/agents/ag-ui/transport.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const virtualId = "\0opensesame-ag-ui-sse-client";
const sourceIds = Object.freeze({
  types: "\0opensesame-ag-ui-sse-client/agent-types.ts",
  logger: "\0opensesame-ag-ui-sse-client/debug-logger.ts",
  http: "\0opensesame-ag-ui-sse-client/http-request.ts",
  sse: "\0opensesame-ag-ui-sse-client/sse.ts",
});
const sourceIdValues = Object.freeze(Object.values(sourceIds));
const runtimeSourceIds = Object.freeze([sourceIds.http, sourceIds.sse]);

const pins = Object.freeze({
  "package.json":
    "554d07ee71a7b1875e51f7fdc20ca21c5d1a7e1074320a8eea149f2469cd47ee",
  "dist/index.mjs":
    "4d21a9ac72d854741b52a9ee36fc21e04dbdc26c1861f052459450b9ad38ea19",
  "dist/index.mjs.map":
    "5625a0cc97b11a38a2531e0c0681b53189b873c57333c3fc2dcdc91005d3457c",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateAgUiBrowserSource(relativePath, source) {
  if (digest(source) !== pins[relativePath])
    throw new Error(`AG-UI browser entry pin mismatch: ${relativePath}`);
}

export function readAgUiBrowserInputs() {
  const packageRoot = dependencyRoot(pagesPackage, "@ag-ui/client");
  const sources = Object.fromEntries(
    Object.keys(pins).map((relativePath) => {
      const path = join(packageRoot, relativePath).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      validateAgUiBrowserSource(relativePath, source);
      return [relativePath, { path, source }];
    }),
  );
  const manifest = JSON.parse(sources["package.json"].source);
  if (manifest.name !== "@ag-ui/client" || manifest.version !== "1.0.4")
    throw new Error("AG-UI browser entry package pin mismatch");
  const map = JSON.parse(sources["dist/index.mjs.map"].source);
  const source = (name) => {
    const index = map.sources.indexOf(name);
    const content = map.sourcesContent?.[index];
    if (index < 0 || typeof content !== "string") {
      throw new Error(`AG-UI browser source map lost ${name}`);
    }
    return content;
  };
  const officialSources = Object.freeze({
    types: source("../src/agent/types.ts"),
    logger: source("../src/debug-logger.ts"),
    http: source("../src/run/http-request.ts"),
    sse: source("../src/transform/sse.ts"),
  });
  return Object.freeze({ packageRoot, sources, officialSources });
}

export function renderAgUiSseClient() {
  return `export { runHttpRequest } from ${JSON.stringify(sourceIds.http)};
export { parseSSEStream } from ${JSON.stringify(sourceIds.sse)};
`;
}

function renderOfficialSource(input, id) {
  if (id === sourceIds.types) return input.officialSources.types;
  if (id === sourceIds.logger) {
    return input.officialSources.logger.replace(
      'from "@/agent/types"',
      `from ${JSON.stringify(sourceIds.types)}`,
    );
  }
  if (id === sourceIds.http) return input.officialSources.http;
  if (id === sourceIds.sse) {
    return input.officialSources.sse
      .replace(
        'from "../run/http-request"',
        `from ${JSON.stringify(sourceIds.http)}`,
      )
      .replace(
        'from "@/debug-logger"',
        `from ${JSON.stringify(sourceIds.logger)}`,
      );
  }
  return null;
}

/** Keep the product's official SSE leaves without the general protobuf client. */
export function agUiBrowserEntry() {
  let input;
  let resolved = 0;
  return {
    name: "opensesame-ag-ui-browser-entry",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readAgUiBrowserInputs();
      resolved = 0;
    },
    resolveId(source, importer) {
      if (!input) throw new Error("AG-UI browser entry was not initialized");
      if (sourceIdValues.includes(source)) return source;
      if (
        source === "@ag-ui/client" &&
        importer?.replaceAll("\\", "/") === transportPath
      ) {
        resolved += 1;
        return virtualId;
      }
      return null;
    },
    load(id) {
      if (!input) throw new Error("AG-UI browser entry was not initialized");
      if (id === virtualId) return renderAgUiSseClient();
      return renderOfficialSource(input, id);
    },
    generateBundle() {
      const ids = [...this.getModuleIds()].map((id) =>
        id.replaceAll("\\", "/"),
      );
      if (!ids.includes(transportPath)) return;
      if (resolved !== 1)
        throw new Error(`AG-UI browser boundary mismatch: client=${resolved}`);
      if (!ids.includes(virtualId))
        throw new Error("AG-UI browser build lost the SSE boundary");
      // The product never supplies the optional debug logger, so Rolldown can
      // erase it together with its type-only agent-types import. Both sources
      // remain extracted and content-pinned above; the HTTP and SSE leaves are
      // the official runtime contract that must survive into the graph.
      for (const id of runtimeSourceIds) {
        if (!ids.includes(id))
          throw new Error(`AG-UI browser build lost official source ${id}`);
      }
    },
  };
}
