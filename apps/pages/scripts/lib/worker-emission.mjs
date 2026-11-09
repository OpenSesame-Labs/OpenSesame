const chunksByBundle = new WeakMap();

export function workerChunkFor(bundle, fileName) {
  return chunksByBundle.get(bundle)?.get(fileName);
}

export function prunePlaceholderAssets(bundle) {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk") continue;
    for (const file of chunk.viteMetadata?.importedAssets ?? []) {
      if (bundle[file]) continue;
      if (!/!~{[0-9a-f]+}~/.test(file))
        throw new Error("Worker closure asset is absent.");
      chunk.viteMetadata.importedAssets.delete(file);
    }
  }
}

export function emitWorkerChunks(ctx, bundle, chunks, emittedChunks) {
  chunksByBundle.set(bundle, emittedChunks);
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
