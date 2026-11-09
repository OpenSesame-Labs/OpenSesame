/**
 * One chunk per built-in item-type pack (ADR 0165).
 *
 * A pack's definition is ~2 KB, so automatic chunking may place it in a larger
 * eagerly loaded chunk. Naming each module here keeps it a leaf of its own:
 * reached only through the loader's dynamic `import()`, fetched when a person
 * switches the type on.
 */

const toPosix = (path) => path.replace(/\\/g, "/");

const PACK =
  /\/packages\/vault-item-types\/src\/packs\/([a-z0-9-]+)\.generated\.[jt]s$/;

export function itemTypePackChunk(id) {
  const match = PACK.exec(toPosix(id));
  return match ? `item-type-pack-${match[1]}` : undefined;
}
