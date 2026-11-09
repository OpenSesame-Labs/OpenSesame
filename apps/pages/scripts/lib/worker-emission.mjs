export function prunePlaceholderAssets(bundle) {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk") continue;
    for (const file of chunk.viteMetadata?.importedAssets ?? [])
      if (!bundle[file] && /!~{[0-9a-f]+}~/.test(file))
        chunk.viteMetadata.importedAssets.delete(file);
  }
}

export function emitWorkerChunks(ctx, bundle, chunks, emittedChunks) {
  for (const chunk of chunks) {
    emittedChunks.set(chunk.fileName, chunk);
    Reflect.deleteProperty(bundle, chunk.fileName);
    ctx.emitFile({
      type: "asset",
      fileName: chunk.fileName,
      names: [],
      originalFileNames: [],
      needsCodeReference: false,
      source: chunk.code,
    });
  }
}
