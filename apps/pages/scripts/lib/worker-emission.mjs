const chunksByFileName = new Map();

export function workerChunkFor(_bundle, fileName) {
  return chunksByFileName.get(fileName);
}

export function prunePlaceholderAssets(bundle) {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk") continue;
    for (const file of chunk.viteMetadata?.importedAssets ?? []) {
      if (bundle[file]) continue;
      if (/!~{[0-9a-f]+}~/.test(file))
        chunk.viteMetadata.importedAssets.delete(file);
    }
  }
}

export function emitWorkerChunks(ctx, bundle, chunks, emittedChunks) {
  chunksByFileName.clear();
  for (const chunk of chunks) {
    chunksByFileName.set(chunk.fileName, chunk);
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
