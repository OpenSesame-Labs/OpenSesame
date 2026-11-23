/** Bind a vault body's multi-file projection to its original owner. */
import { Effect } from "effect";
import type { SecretFsError } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { checkWriteOwner } from "./files-owner.js";

export function captureOwnedBodyFiles(files: SecretFiles) {
  const read = files.read.bind(files);
  const list = files.list.bind(files);
  const write = files.writeGuarded?.bind(files);
  const remove = files.removeGuarded?.bind(files);
  if (!write || !remove) return undefined;
  return (check: () => void): SecretFiles => {
    const guarded = <A>(
      path: string,
      run: () => Effect.Effect<A, SecretFsError>,
    ) =>
      checkWriteOwner(path, check).pipe(
        Effect.flatMap(() => Effect.suspend(run)),
        Effect.tap(() => checkWriteOwner(path, check)),
      );
    return {
      read: (path) => guarded(path, () => read(path)),
      list: (path) => guarded(path, () => list(path)),
      write: (path, bytes, options) =>
        guarded(path, () => write(path, bytes, check, options)),
      remove: (path, options) =>
        guarded(path, () => remove(path, check, options)),
    };
  };
}
