export function chunkName(output) {
  if (output.manualChunks instanceof Function) return output.manualChunks;
  const groups = output.codeSplitting?.groups ?? [];
  if (groups.length === 0) return null;
  return (id, api) => {
    for (const group of groups) {
      const test = group.test;
      if (test instanceof RegExp) {
        test.lastIndex = 0;
        if (!test.test(id)) continue;
      } else if (test instanceof Function) {
        if (!test(id, api)) continue;
      } else if (test !== undefined && !id.includes(test)) {
        continue;
      }
      const name =
        group.name instanceof Function ? group.name(id, api) : group.name;
      if (name) return name;
    }
    return undefined;
  };
}

export function installChunkName(output, name) {
  const current = Array.isArray(output.codeSplitting?.groups)
    ? output.codeSplitting
    : {};
  output.codeSplitting = {
    ...current,
    includeDependenciesRecursively: false,
    groups: [
      { name, includeDependenciesRecursively: false, minSize: 0 },
      ...(current.groups ?? []).map((group) => ({
        ...group,
        includeDependenciesRecursively: false,
        minSize: group.minSize ?? 0,
      })),
    ],
  };
  output.strictExecutionOrder = true;
  Reflect.deleteProperty(output, "manualChunks");
  Reflect.deleteProperty(output, "onlyExplicitManualChunks");
  Reflect.deleteProperty(output, "experimentalMinChunkSize");
}
