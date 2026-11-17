/** A failed or empty run is never evidence of an explored behavior. */
export function checkExploration(result, target, width, mutant) {
  if (mutant) {
    if (result.code === 0 || !result.sawViolation) {
      throw new Error(`The ${target} mutation was not detected`);
    }
  } else if (result.code !== 0 || !result.sawClick) {
    throw new Error(`Bombadil failed for ${target} at ${width}px`);
  }
}

/** Check that exploration actually attempted each switch scenario. */
export function switchCoverage(trace) {
  const lines = trace.trim().split("\n");
  const last = JSON.parse(lines.at(-1) ?? "null");
  const coverage = last?.snapshots?.find(
    (snapshot) => snapshot.name === "state",
  )?.value?.coverage;
  for (const scenario of ["accepted", "rejected", "disabled"]) {
    if (!Number.isInteger(coverage?.[scenario]) || coverage[scenario] < 1) {
      throw new Error(`Bombadil did not exercise ${scenario} switch attempts`);
    }
  }
  return coverage;
}
