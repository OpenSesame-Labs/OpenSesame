import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkImports, loadLexer } from "./verify-dist-checks.mjs";

/**
 * Terser can remove a dynamic import after Rollup recorded its edge. Keep
 * the conservative build-time graph for admission, then record only edges
 * still present in the emitted code. Never add an unreviewed disk edge: the
 * independent verifier must reject it.
 */
export async function recordElidedDynamicImports(graph, dist, repoRoot) {
  const { init, parse } = await loadLexer(repoRoot);
  await init;
  const dropped = [...(graph.droppedReferences ?? [])];
  for (const chunk of graph.chunks) {
    const code = readFileSync(join(dist, chunk.file), "utf8");
    const [imports] = parse(code);
    // An expression could still reach a declared target. Keep every edge in
    // that chunk until its dynamic imports can be resolved independently.
    const unresolved = imports.some((entry) => {
      if (entry.d < 0 || entry.n !== undefined) return false;
      return !/^["'`]([^"'`]+)["'`]$/.test(code.slice(entry.s, entry.e).trim());
    });
    if (unresolved) continue;
    const actual = chunkImports(parse, code, chunk.file).dynamic;
    chunk.dynamicImports = chunk.dynamicImports.filter((to) => {
      if (actual.has(to)) return true;
      dropped.push({ from: chunk.file, to });
      return false;
    });
  }
  if (dropped.length)
    graph.droppedReferences = dropped.sort((a, b) =>
      `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`),
    );
}
