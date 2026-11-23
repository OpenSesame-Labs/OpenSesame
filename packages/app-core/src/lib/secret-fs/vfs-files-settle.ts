/** Surface store failures as their original errors at the VFS boundary. */
import { VaultCorruptError } from "@opensesame/vault-core";
import { Cause, Effect, Exit } from "effect";
import type { SecretFsError } from "./errors.js";

export async function settle<A>(
  effect: Effect.Effect<A, SecretFsError>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "Some") {
    const error = failure.value;
    throw error._tag === "SecretFsRejected" && error.kind === "corrupt"
      ? new VaultCorruptError(error.message)
      : error;
  }
  throw Cause.squash(exit.cause);
}
