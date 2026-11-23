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

/**
 * `expected` is the manifest revision this process last saw (`null`: none), or
 * `undefined` when it never opened the body, so whatever stands is removed.
 * `manifestGone` runs once no manifest remains, so a retry after a later
 * failure expects none rather than mistaking this removal for a rival's.
 */
export function removeBodyFiles(
  files: SecretFiles,
  tomb: string,
  expected: Revision | null | undefined,
  manifestGone: () => void = () => {},
) {
  return Effect.gen(function* () {
    const leftovers = yield* files.list(`${tomb}/${SECRETS_DIR}`);
    const staging = yield* files.list(`${tomb}/staging`);
    const manifestPath = `${tomb}/${MANIFEST_FILE}`;
    const manifest = yield* files
      .read(manifestPath)
      .pipe(Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)));
    if (expected !== undefined && (manifest?.revision ?? null) !== expected)
      return yield* new SecretFsConflict({
        path: manifestPath,
        expected,
        actual: manifest?.revision ?? null,
      });
    if (manifest)
      yield* files.remove(manifestPath, { ifRevision: manifest.revision });
    manifestGone();
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

type BodyState = {
  mirror: Map<string, string>;
  projections: Map<string, TombProjection>;
  dirty: Set<string>;
};

/** The manifest revision to hold a destruction to; unknown until opened or written here. */
export function destroyExpectation(
  held: BodyState,
  tomb: string,
): Revision | null | undefined {
  const known = held.projections.get(tomb);
  return known?.sealedProbe === undefined ? undefined : known.manifestRevision;
}

/** Record that this destruction removed the manifest, before it retires the rest. */
export function manifestRemoved(held: BodyState, tomb: string) {
  return () => {
    const known = held.projections.get(tomb);
    if (!known) return;
    const { manifestBytes: _gone, ...rest } = known;
    held.projections.set(tomb, {
      ...rest,
      manifestRevision: null,
      items: new Map(),
    });
  };
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
