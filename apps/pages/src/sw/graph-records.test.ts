import { type JsonObject, isJsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { parseCapabilityGraph, resolvePlanAssets } from "./graph.js";
import { decodeGraph, encodeGraph } from "./graph-records.js";

const module = (
  id: string,
  classification: "core" | "shared" | "optional",
  capability: string | null,
  moduleId?: string | null,
) => {
  const record: JsonObject = {
    id,
    classification,
    capability,
    rationale: "documented owner",
    size: 42,
  };
  if (moduleId !== undefined) record.moduleId = moduleId;
  return record;
};

const graph: JsonObject = {
  entries: [{ html: "index.html", capability: null, assets: ["icon.svg"] }],
  chunks: [
    {
      file: "main.js",
      isEntry: true,
      imports: ["shared.js"],
      dynamicImports: ["mixed.js", "on-demand.js"],
      modules: [
        module("apps/pages/src/main.ts", "core", null),
        module("bootstrap", "core", null),
      ],
    },
    {
      file: "shared.js",
      modules: [
        module("common", "shared", null),
        module("empty-id", "shared", null, null),
      ],
    },
    {
      file: "mixed.js",
      modules: [
        module("approved", "optional", "a.b", "a.b/runtime"),
        module("other", "optional", "c.d", "c.d/runtime"),
      ],
    },
    {
      file: "on-demand.js",
      onDemand: true,
      modules: [module("package", "optional", "a.b")],
    },
    {
      file: "unknown-url.js",
      imports: ["https://evil.test/x.js"],
      modules: [module("outside", "optional", "x.y")],
    },
  ],
};

function legacyProjection(wire: JsonObject): JsonObject {
  const {
    graphFormat: _format,
    sourceCapabilities: _capabilities,
    sourceRationales: _rationales,
    sourcePaths: _paths,
    ...legacy
  } = wire;
  const chunks = legacy.chunks;
  if (!Array.isArray(chunks)) throw new Error("bad fixture");
  return {
    ...legacy,
    chunks: chunks.map((chunk) => {
      if (!isJsonObject(chunk)) throw new Error("bad fixture");
      const { sourceModules: _sources, ...projected } = chunk;
      return projected;
    }),
  };
}

function plan(value: JsonObject, ids: string[]) {
  const parsed = parseCapabilityGraph(value);
  if (!parsed) throw new Error("graph rejected");
  return resolvePlanAssets(parsed, ids);
}

describe("capability graph source records", () => {
  it("reconstructs every record without losing module ids, classifications or provenance", () => {
    const wire = encodeGraph(graph);
    expect(decodeGraph(JSON.parse(JSON.stringify(wire)))).toEqual(graph);
    expect(JSON.stringify(encodeGraph(graph))).toBe(JSON.stringify(wire));
    expect(wire.graphFormat).toBe("opensesame-capability-graph/2");
  });

  it("gives deployed workers and the current worker the same plans, including denials and on-demand files", () => {
    const wire = encodeGraph(graph);
    for (const ids of [
      [],
      ["a.b/runtime"],
      ["c.d/runtime"],
      ["a.b/runtime", "c.d/runtime"],
      ["unknown.cap/runtime"],
      ["x.y/runtime"],
    ]) {
      expect(plan(legacyProjection(wire), ids)).toEqual(plan(graph, ids));
      expect(plan(wire, ids)).toEqual(plan(graph, ids));
    }
    expect(plan(wire, ["a.b/runtime"])).toEqual({
      ok: true,
      files: ["icon.svg", "main.js", "mixed.js", "shared.js"],
    });
    expect(plan(wire, ["unknown.cap/runtime"])).toEqual({
      ok: false,
      unknown: ["unknown.cap/runtime"],
    });
  });

  it("rejects damaged tables, changed ownership, missing format and future formats", () => {
    const wire = encodeGraph(graph);
    const copy = () => JSON.parse(JSON.stringify(wire));
    const invalidIndex = copy();
    invalidIndex.chunks[0].sourceModules[0][2] = 999999;
    const invalidPath = copy();
    invalidPath.chunks[0].sourceModules[0][0][0] = 999999;
    const duplicatePaths = copy();
    duplicatePaths.sourcePaths.push(duplicatePaths.sourcePaths[0]);
    const alteredOwner = copy();
    alteredOwner.chunks[2].modules[0].classification = "shared";
    const missingFormat = copy();
    delete missingFormat.graphFormat;
    const future = copy();
    future.graphFormat = "opensesame-capability-graph/3";
    const missingProvenance = copy();
    missingProvenance.chunks[0].sourceModules[0].pop();
    for (const damaged of [
      invalidIndex,
      invalidPath,
      duplicatePaths,
      alteredOwner,
      missingFormat,
      future,
      missingProvenance,
    ]) {
      expect(decodeGraph(damaged)).toBeNull();
      expect(parseCapabilityGraph(damaged)).toBeNull();
    }
  });

  it("refuses to discard unrecognized source fields during encoding", () => {
    const extended = structuredClone(graph);
    const chunks = extended.chunks;
    if (!Array.isArray(chunks) || !isJsonObject(chunks[0]))
      throw new Error("bad fixture");
    const records = chunks[0].modules;
    if (!Array.isArray(records) || !isJsonObject(records[0]))
      throw new Error("bad fixture");
    records[0].unexpected = "must not disappear";
    expect(() => encodeGraph(extended)).toThrow(
      "Invalid capability source record",
    );
  });
});
