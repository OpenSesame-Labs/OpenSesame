import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const normalizedId = (id) => id.replaceAll("\\", "/");

export function createGeneratedDataAssets(
  generatedModules,
  readPackedGeneratedData,
  renderGeneratedDataModule,
) {
  let transformed = new Set();
  const jsonDescriptors = generatedModules.filter(
    (descriptor) => descriptor.kind === "json-default",
  );
  const jsonIds = new Map(
    jsonDescriptors.map((descriptor, index) => [
      `\0opensesame:generated-json:${index}`,
      descriptor,
    ]),
  );
  return {
    name: "opensesame-generated-data-assets",
    apply: "build",
    enforce: "pre",
    buildStart() {
      transformed = new Set();
    },
    resolveId(source, importer) {
      for (const [id, descriptor] of jsonIds) {
        if (
          source === descriptor.specifier ||
          normalizedId(source) === descriptor.path
        ) {
          return id;
        }
        if (
          importer &&
          source.startsWith(".") &&
          normalizedId(resolve(dirname(importer.split("?", 1)[0]), source)) ===
            descriptor.path
        ) {
          return id;
        }
      }
      return null;
    },
    load(id) {
      const descriptor = jsonIds.get(id);
      if (!descriptor) return null;
      const source = readFileSync(descriptor.path, "utf8");
      const data = readPackedGeneratedData(source, descriptor);
      const referenceId = this.emitFile({
        type: "asset",
        name: descriptor.assetName,
        source: JSON.stringify(data),
      });
      transformed.add(descriptor.path);
      return renderGeneratedDataModule(source, descriptor, referenceId);
    },
    transform(source, id) {
      const descriptor = generatedModules.find(
        (candidate) => normalizedId(id) === candidate.path,
      );
      if (!descriptor) return null;
      if (descriptor.kind === "json-default") return null;
      if (transformed.has(descriptor.path)) {
        throw new Error(`${descriptor.exportName} transformed more than once`);
      }
      const data = readPackedGeneratedData(source, descriptor);
      const referenceId = this.emitFile({
        type: "asset",
        name: descriptor.assetName,
        source: JSON.stringify(data),
      });
      transformed.add(descriptor.path);
      return renderGeneratedDataModule(source, descriptor, referenceId);
    },
  };
}
