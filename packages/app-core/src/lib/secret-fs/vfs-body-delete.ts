/** Remove a file-backed body before retiring its in-process projection. */
import { Effect } from "effect";
import { SecretFsConflict } from "./errors.js";
import type { Revision, SecretFiles } from "./files.js";
import { SECRETS_DIR } from "./layout.js";
import {
  LEGACY_BODY_FILE,
  MANIFEST_FILE,
  type TombProjection,
} from "./secret-docs.js";
import { bodyKey } from "./vfs-file-keys.js";

export function removeBodyFiles(
  files: SecretFiles,
  tomb: string,
  expected: Revision | null,
) {
  return Effect.gen(function* () {
    const leftovers = yield* files.list(`${tomb}/${SECRETS_DIR}`);
    const staging = yield* files.list(`${tomb}/staging`);
    const manifestPath = `${tomb}/${MANIFEST_FILE}`;
    const manifest = yield* files
      .read(manifestPath)
      .pipe(Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)));
    if ((manifest?.revision ?? null) !== expected)
      return yield* new SecretFsConflict({
        path: manifestPath,
        expected,
        actual: manifest?.revision ?? null,
      });
    if (manifest)
      yield* files.remove(manifestPath, { ifRevision: manifest.revision });
    for (const path of [
      ...leftovers,
      ...staging,
      `${tomb}/${LEGACY_BODY_FILE}`,
    ]) {
      const current = yield* files
        .read(path)
        .pipe(Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)));
      if (current) yield* files.remove(path, { ifRevision: current.revision });
    }
  });
}

export function forgetBodyState(
  held: {
    mirror: Map<string, string>;
    projections: Map<string, TombProjection>;
    dirty: Set<string>;
  },
  tomb: string,
): void {
  held.projections.delete(tomb);
  held.dirty.delete(tomb);
  held.mirror.delete(bodyKey(tomb));
}
