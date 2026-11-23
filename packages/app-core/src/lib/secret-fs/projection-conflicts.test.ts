import {
  type VaultBody,
  createItem,
  emptyBody,
  mintVaultKey,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { SecretFsError } from "./errors.js";
import { SecretFsUnavailable } from "./errors.js";
import { failureOf } from "./files.conformance.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import { EMPTY_PROJECTION } from "./secret-docs.js";

const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(effect);

const note = (id: string, name: string) => ({
  ...createItem("note", name),
  id,
});
const bodyOf = (
  rev: number,
  ...items: ReturnType<typeof note>[]
): VaultBody => ({
  ...emptyBody(),
  rev,
  items,
});

describe("rejecting concurrent projection edits", () => {
  it("will not replace a secret's document another writer has changed since it was read", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const ours = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    // A rival saves a change to the same secret and commits.
    await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "rival" }),
        ours,
      ),
    );
    // We, still at revision 1 of the manifest, are refused before touching anything.
    const refused = await failureOf(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "ours" }),
        ours,
      ),
    );
    expect(refused._tag).toBe("SecretFsConflict");
    const settled = await run(readProjection(files, "t", key));
    expect(settled?.body.items[0]?.notes).toBe("rival");
  });

  it("refuses a document written over in the instant after the manifest check", async () => {
    const inner = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const ours = await run(
      writeProjection(
        inner,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    // The rival lands its document just as ours is being written.
    let raced = false;
    const racing: SecretFiles = {
      ...inner,
      write: (path, data, options) => {
        if (!raced && /\/x~v[0-9a-f]{32}\.note\.json$/u.test(path)) {
          raced = true;
          return inner
            .write(path, new Uint8Array([1, 2, 3]))
            .pipe(Effect.andThen(inner.write(path, data, options)));
        }
        return inner.write(path, data, options);
      },
    };
    const refused = await failureOf(
      writeProjection(
        racing,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "ours" }),
        ours,
      ),
    );
    expect(refused._tag).toBe("SecretFsConflict");
  });

  it("detects and preserves a direct edit made while a replacement is staged", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const ours = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    const prior = ours.items.get("a");
    if (!prior) throw new Error("missing prior projection");
    const changed = new Uint8Array([7, 8, 9]);
    let raced = false;
    const racing: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        !raced && path.includes("/secrets/") && path !== `t/${prior.file}`
          ? Effect.gen(function* () {
              raced = true;
              yield* files.write(`t/${prior.file}`, changed);
              return yield* files.write(path, data, options);
            })
          : files.write(path, data, options),
    };
    await expect(
      run(
        writeProjection(
          racing,
          "t",
          key,
          bodyOf(2, { ...note("a", "x"), notes: "ours" }),
          ours,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsConflict" });
    expect((await run(files.read(`t/${prior.file}`))).bytes).toEqual(changed);
  });

  it("rolls the manifest back when a valid direct edit lands at commit", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const first = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    const prior = first.items.get("a");
    if (!prior) throw new Error("Missing prior document");
    const failing: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        path.endsWith("/vault.json")
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : files.write(path, data, options),
    };
    await expect(
      run(
        writeProjection(
          failing,
          "t",
          key,
          bodyOf(2, { ...note("a", "x"), notes: "direct" }),
          first,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });
    const orphan = (await run(files.list("t/secrets"))).find(
      (path) => path !== `t/${prior.file}`,
    );
    if (!orphan) throw new Error("Missing staged direct edit");
    const direct = (await run(files.read(orphan))).bytes;
    let crossed = false;
    const racing: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        path.endsWith("/vault.json") && !crossed
          ? Effect.gen(function* () {
              crossed = true;
              yield* files.write(`t/${prior.file}`, direct);
              return yield* files.write(path, data, options);
            })
          : files.write(path, data, options),
    };
    await expect(
      run(
        writeProjection(
          racing,
          "t",
          key,
          bodyOf(2, { ...note("a", "x"), notes: "ours" }),
          first,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsConflict" });
    expect(
      (await run(readProjection(files, "t", key)))?.body.items[0]?.notes,
    ).toBe("direct");
  });
});
