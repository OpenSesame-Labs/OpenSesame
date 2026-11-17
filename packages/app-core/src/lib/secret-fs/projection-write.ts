/**
 * Writing a vault as documents (ADR 0182): decide which secrets' files
 * changed, write those, commit the manifest, then clear what no longer
 * belongs. The format and the order are `secret-docs.ts`'s to state.
 */
import type { VaultBody } from "@opensesame/vault-core";
import { Effect } from "effect";
import type { SecretFsError } from "./errors.js";
import { SecretFsConflict } from "./errors.js";
import type { Revision, SecretFiles } from "./files.js";
import { revisionOf } from "./files.js";
import { type Changed, plan } from "./projection-plan.js";
import { beginStaging, removeLeftovers } from "./projection-staging.js";
import {
  CONCURRENCY,
  FOLDER_FORMAT,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  type Projected,
  SECRET_FORMAT,
  type TombProjection,
  encode,
  folderBinding,
  kindOf,
  manifestBinding,
  sealed,
  secretBinding,
} from "./secret-docs.js";

/** Look before writing anything: a writer that lost the race finds out before its documents replace the winner's. */
function assertStanding(
  files: SecretFiles,
  tomb: string,
  prev: TombProjection,
): Effect.Effect<void, SecretFsError> {
  const path = `${tomb}/${MANIFEST_FILE}`;
  return Effect.gen(function* () {
    const standing = yield* files.read(path).pipe(
      Effect.map((file) => file.revision),
      Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)),
    );
    if (standing !== prev.manifestRevision) {
      return yield* new SecretFsConflict({
        path,
        expected: prev.manifestRevision,
        actual: standing,
      });
    }
  });
}

/** Hold every document named by the manifest to the bytes originally read. */
function assertDocumentsStanding(
  files: SecretFiles,
  tomb: string,
  prev: TombProjection,
): Effect.Effect<void, SecretFsError> {
  return Effect.forEach(
    [...prev.items.values()].filter(
      (entry): entry is Projected & { revision: Revision } =>
        entry.revision !== undefined,
    ),
    (entry) =>
      files.read(`${tomb}/${entry.file}`).pipe(
        Effect.flatMap((current) =>
          current.revision === entry.revision
            ? Effect.void
            : Effect.fail(
                new SecretFsConflict({
                  path: `${tomb}/${entry.file}`,
                  expected: entry.revision,
                  actual: current.revision,
                }),
              ),
        ),
        Effect.catchTag("SecretFsNotFound", () =>
          Effect.fail(
            new SecretFsConflict({
              path: `${tomb}/${entry.file}`,
              expected: entry.revision,
              actual: null,
            }),
          ),
        ),
      ),
    { concurrency: CONCURRENCY, discard: true },
  );
}

function writeDocument(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  rev: number,
  { subject, entry, expect }: Changed,
): Effect.Effect<Revision, SecretFsError> {
  return Effect.gen(function* () {
    const path = `${tomb}/${entry.file}`;
    const doc =
      subject.kind === "item"
        ? encode({
            format: SECRET_FORMAT,
            version: 1,
            kind: kindOf(subject.item),
            sealed: yield* sealed(
              key,
              { v: 1, rev, item: subject.item },
              secretBinding(tomb, subject.id),
              path,
            ),
          })
        : encode({
            format: FOLDER_FORMAT,
            version: 1,
            sealed: yield* sealed(
              key,
              { v: 1, rev, folder: subject.folder },
              folderBinding(tomb, subject.id),
              path,
            ),
          });
    return yield* files.write(
      path,
      doc,
      // Another writer's change to this document since we read it is theirs to keep.
      { ifRevision: expect },
    );
  });
}

/** The manifest, written with the revision it was read at: this is what commits. */
function commitManifest(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  body: VaultBody,
  next: ReadonlyMap<string, Projected>,
  prev: TombProjection,
): Effect.Effect<
  Readonly<{ revision: Revision; bytes: Uint8Array }>,
  SecretFsError
> {
  const path = `${tomb}/${MANIFEST_FILE}`;
  return Effect.gen(function* () {
    const { items, folders, ...rest } = body;
    const listing = (id: string) => ({
      id,
      file: next.get(id)?.file ?? "",
      logical: next.get(id)?.logical,
      rev: next.get(id)?.rev ?? body.rev ?? 0,
    });
    const blob = yield* sealed(
      key,
      {
        ...rest,
        items: items.map((item) => listing(item.id)),
        folders: folders.map((folder) => listing(folder.id)),
      },
      manifestBinding(tomb),
      path,
    );
    const bytes = encode({ format: MANIFEST_FORMAT, version: 1, sealed: blob });
    const intended = revisionOf(bytes);
    const revision = yield* files
      .write(path, bytes, { ifRevision: prev.manifestRevision })
      .pipe(
        Effect.catch((writeError) =>
          files.read(path).pipe(
            Effect.flatMap((stored) =>
              stored.revision === intended
                ? Effect.succeed(intended)
                : Effect.fail(writeError),
            ),
            Effect.catch(() => Effect.fail(writeError)),
          ),
        ),
      );
    return { revision, bytes };
  });
}

/** Restore the prior commit if a direct document edit crossed our commit. */
function restoreManifest(
  files: SecretFiles,
  tomb: string,
  prev: TombProjection,
  committed: Revision,
): Effect.Effect<void, SecretFsError> {
  const path = `${tomb}/${MANIFEST_FILE}`;
  if (prev.manifestRevision === null)
    return files.remove(path, { ifRevision: committed });
  if (!prev.manifestBytes)
    return Effect.fail(
      new SecretFsConflict({
        path,
        expected: prev.manifestRevision,
        actual: committed,
      }),
    );
  return files
    .write(path, prev.manifestBytes, { ifRevision: committed })
    .pipe(Effect.asVoid);
}

/**
 * Write `body` as documents, changed ones first, then the manifest that
 * commits them, then remove what no longer belongs. A document that did not
 * change is not touched, so an edit to one secret rewrites one file.
 */
export function writeProjection(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  body: VaultBody,
  prev: TombProjection,
  freshFiles = false,
): Effect.Effect<TombProjection, SecretFsError> {
  return Effect.gen(function* () {
    yield* assertStanding(files, tomb, prev);
    yield* assertDocumentsStanding(files, tomb, prev);
    // Only attempts already present before this commit are eligible for its
    // cleanup. A writer that starts after our manifest cannot be collected.
    const stagingJournals = yield* files
      .list(`${tomb}/staging`)
      .pipe(Effect.orElseSucceed(() => []));
    const { next, changed } = plan(tomb, body, prev, freshFiles);
    const staging = yield* beginStaging(files, tomb, key, changed);
    const written = yield* Effect.forEach(
      changed,
      (one) => writeDocument(files, tomb, key, body.rev ?? 0, one),
      { concurrency: CONCURRENCY },
    );
    changed.forEach(({ subject, entry }, at) => {
      next.set(subject.id, { ...entry, revision: written[at] });
    });
    // A direct editor that does not update the manifest must not be silently
    // discarded while this writer stages its immutable replacement.
    yield* assertDocumentsStanding(files, tomb, prev);
    const committed = yield* commitManifest(files, tomb, key, body, next, prev);
    const crossed = yield* assertDocumentsStanding(files, tomb, prev).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => null,
      }),
    );
    if (crossed) {
      yield* restoreManifest(files, tomb, prev, committed.revision);
      return yield* Effect.fail(crossed);
    }
    if (staging)
      yield* files
        .remove(staging.path, { ifRevision: staging.revision })
        .pipe(Effect.ignore);
    yield* removeLeftovers(files, tomb, key, next, prev, stagingJournals);
    return {
      manifestRevision: committed.revision,
      manifestBytes: committed.bytes,
      items: next,
      legacyBody: false,
    };
  });
}
