/** Names the host modules that leaked into a worker-private chunk or closure. */
function hostModules(chunk, minted, pure) {
  return Object.keys(chunk.modules).filter(
    (id) => !minted.has(id) && !pure.test(id.replaceAll("\\", "/")),
  );
}
export function hostModuleError(chunk, minted, label, pure) {
  const modules = hostModules(chunk, minted, pure);
  return new Error(
    `${label}: ${chunk.fileName}; host modules (${modules.length}): ${modules
      .slice(0, 8)
      .map((id) => JSON.stringify(id))
      .join(", ")}`,
  );
}
