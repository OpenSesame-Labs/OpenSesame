import { isString } from "../../../../packages/os-domain/src/json.ts";
import { VIRTUAL_MODULES, pathTo } from "./capability-graph.mjs";

/** Record only foreign optional sources explicitly reached by each table root. */
export function capabilitySourceClosures(ctx, classify) {
  const table = ctx.getModuleInfo(`\0${VIRTUAL_MODULES.table}`);
  if (!table) return [];
  return table.dynamicallyImportedIds
    .map((root) => {
      const entry = classify(root);
      if (!entry.capability)
        throw new Error(`Capability table root has no owner: ${entry.id}`);
      const pending = [root];
      const seen = new Set();
      const allowed = new Set();
      while (pending.length) {
        const id = pending.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const module = classify(id);
        if (
          module.classification === "optional" &&
          module.capability !== entry.capability
        )
          allowed.add(module.id);
        const info = ctx.getModuleInfo(id);
        if (info) pending.push(...info.importedIds);
      }
      return {
        module: entry.id,
        capability: entry.capability,
        allowed: [...allowed].sort(),
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module));
}

function validRoot(root, byModule) {
  return (
    isString(root?.module) &&
    isString(root?.capability) &&
    Array.isArray(root?.allowed) &&
    root.allowed.every(isString) &&
    !byModule.has(root.module)
  );
}

function sourceRoots(graph, add) {
  const roots = graph.capabilitySourceClosures;
  const tableTargets = (graph.moduleEdges ?? []).filter(
    (edge) => edge.viaTable && edge.kind === "dynamic",
  );
  if (!Array.isArray(roots)) {
    if (tableTargets.length)
      add("error", "MISSING_CAPABILITY_SOURCE_CLOSURES", {
        message: "capability table has no source import closures",
      });
    return new Map();
  }
  const byModule = new Map();
  for (const root of roots) {
    if (!validRoot(root, byModule)) {
      add("error", "INVALID_CAPABILITY_SOURCE_CLOSURE", {
        message: "invalid or duplicate capability source closure",
      });
      continue;
    }
    byModule.set(root.module, root);
  }
  for (const edge of tableTargets) {
    const root = byModule.get(edge.to);
    if (!root || root.capability !== edge.toCapability)
      add("error", "MISSING_CAPABILITY_SOURCE_CLOSURE", {
        module: edge.to,
        capability: edge.toCapability,
        message: `capability table root ${edge.to} has no matching source closure`,
      });
  }
  return byModule;
}

function foreignModules(chunk, root, allowed, via, add) {
  for (const module of chunk.modules) {
    if (
      module.classification !== "optional" ||
      module.capability === root.capability ||
      allowed.has(module.id)
    )
      continue;
    add("error", "CAPABILITY_STATIC_FOREIGN_OPTIONAL", {
      module: module.id,
      capability: module.capability,
      chunk: chunk.file,
      entry: root.module,
      path: pathTo(via, chunk.file),
      message: `${root.module} reaches foreign optional source ${module.id} outside its source imports`,
    });
  }
}

function checkRoot(root, graph, chunks, add) {
  const starts = graph.chunks
    .filter(
      (chunk) =>
        chunk.facadeModuleId === root.module ||
        chunk.modules.some((module) => module.id === root.module),
    )
    .map((chunk) => chunk.file);
  if (!starts.length) {
    add("error", "MISSING_CAPABILITY_ROOT_CHUNK", {
      module: root.module,
      capability: root.capability,
      message: `capability table root ${root.module} has no emitted chunk`,
    });
    return;
  }
  const allowed = new Set(root.allowed);
  const via = new Map(starts.map((file) => [file, null]));
  const pending = [...starts];
  while (pending.length) {
    const file = pending.shift();
    const chunk = chunks.get(file);
    if (!chunk) continue;
    foreignModules(chunk, root, allowed, via, add);
    for (const target of chunk.imports) {
      if (via.has(target)) continue;
      via.set(target, file);
      pending.push(target);
    }
  }
}

/** Check the emitted static closure, including lazy-entry facade chunks. */
export function capabilityClosureViolations(graph, add) {
  const roots = sourceRoots(graph, add);
  const chunks = new Map(graph.chunks.map((chunk) => [chunk.file, chunk]));
  for (const root of roots.values()) checkRoot(root, graph, chunks, add);
}
