import {
  type VaultBody,
  createItem,
  emptyBody,
  mintVaultKey,
} from "@opensesame/vault-core";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { SecretFsError } from "./errors.js";
import { SecretFsUnavailable } from "./errors.js";
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

describe("writing a vault as documents", () => {
  it("retries the first save after an interrupted manifest without colliding with orphan documents", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const unavailable: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        path.endsWith("/vault.json")
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : files.write(path, data, options),
    };
    await expect(
      run(
        writeProjection(
          unavailable,
          "t",
          key,
          bodyOf(1, note("a", "x")),
          EMPTY_PROJECTION,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });
    const settled = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    expect(settled.items.get("a")?.file).toMatch(
      /~v[0-9a-f]{32}\.note\.json$/u,
    );
    expect(
      (await run(readProjection(files, "t", key)))?.body.items[0]?.name,
    ).toBe("x");
  });

  it("retries across consecutive commits instead of reporting false corruption", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    let standing = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    let edits = 0;
    const racing: SecretFiles = {
      ...files,
      read: (path) =>
        path.includes("/secrets/") && edits < 2
          ? Effect.gen(function* () {
              edits += 1;
              standing = yield* writeProjection(
                files,
                "t",
                key,
                bodyOf(edits + 1, {
                  ...note("a", "x"),
                  notes: `edit-${edits}`,
                }),
                standing,
              );
              return yield* files.read(path);
            })
          : files.read(path),
    };
    const opened = await run(readProjection(racing, "t", key));
    expect(edits).toBe(2);
    expect(opened?.body.items[0]?.notes).toBe("edit-2");
  });

  it("never puts a new secret's document over a file the committed manifest lists for another", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const first = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x"), note("b", "y")),
        EMPTY_PROJECTION,
      ),
    );
    // A is renamed to z and a new B takes the name x, but the manifest never lands.
    const failing: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        path.endsWith("/vault.json")
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : files.write(path, data, options),
    };
    const exit = await Effect.runPromiseExit(
      writeProjection(
        failing,
        "t",
        key,
        bodyOf(2, note("a", "z"), note("b", "y"), note("c", "x")),
        first,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // The committed vault still opens, with A as it was.
    const reopened = await run(readProjection(files, "t", key));
    expect(reopened?.body.items.map((item) => item.name).sort()).toEqual([
      "x",
      "y",
    ]);
    expect(reopened?.body.items.find((item) => item.id === "a")?.name).toBe(
      "x",
    );
  });

  it("removes an uncommitted staged document when its item is purged", async () => {
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
          bodyOf(2, { ...note("a", "x"), notes: "never committed" }),
          first,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });
    expect(await run(files.list("t/secrets"))).toHaveLength(2);

    const purged = await run(
      writeProjection(files, "t", key, bodyOf(2), first),
    );
    expect(purged.items.size).toBe(0);
    expect(await run(files.list("t/secrets"))).toEqual([]);
    expect((await run(readProjection(files, "t", key)))?.body.items).toEqual(
      [],
    );
  });

  it("never collects a restored item from a writer that starts after a purge commits", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const first = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("id-a", "x")),
        EMPTY_PROJECTION,
      ),
    );
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
          bodyOf(2, { ...note("id-a", "x"), notes: "abandoned" }),
          first,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });

    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    const purging: SecretFiles = {
      ...files,
      read: (path) =>
        path.startsWith("t/staging/") && !held
          ? Effect.gen(function* () {
              held = true;
              reached();
              yield* Effect.promise(() => gate);
              return yield* files.read(path);
            })
          : files.read(path),
    };
    const purge = run(writeProjection(purging, "t", key, bodyOf(2), first));
    await paused;
    const empty = await run(readProjection(files, "t", key));
    if (!empty) throw new Error("Missing purge manifest");
    await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(3, { ...note("id-a", "x"), notes: "restored" }),
        empty.state,
      ),
    );
    release();
    await purge;

    expect(
      (await run(readProjection(files, "t", key)))?.body.items[0]?.notes,
    ).toBe("restored");
  });
});
