import { createItem, emptyBody, mintVaultKey } from "@opensesame/vault-core";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import { EMPTY_PROJECTION } from "./secret-docs.js";

it("removes a fallback-path staged document when its item is purged", async () => {
  const files = makeMemorySecretFiles();
  const key = (await mintVaultKey()).vaultKey;
  const folder = {
    id: "long-folder",
    name: Array.from({ length: 11 }, () => "folder".repeat(13)).join("/"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const item = {
    ...createItem("note", "long path item"),
    id: "long-item",
    folderId: folder.id,
  };
  const body = { ...emptyBody(), rev: 1, folders: [folder], items: [item] };
  const first = await Effect.runPromise(
    writeProjection(files, "t", key, body, EMPTY_PROJECTION),
  );
  expect(first.items.get(item.id)?.file).toMatch(
    /^secrets\/versions\/[0-9a-f]{32}\.note\.json$/u,
  );

  const failing: SecretFiles = {
    ...files,
    write: (path, data, options) =>
      path.endsWith("/vault.json")
        ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
        : files.write(path, data, options),
  };
  await expect(
    Effect.runPromise(
      writeProjection(
        failing,
        "t",
        key,
        { ...body, rev: 2, items: [{ ...item, notes: "uncommitted" }] },
        first,
      ),
    ),
  ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });
  const noteFiles = async () =>
    (await Effect.runPromise(files.list("t/secrets/versions"))).filter((path) =>
      path.endsWith(".note.json"),
    );
  expect(await noteFiles()).toHaveLength(2);

  await Effect.runPromise(
    writeProjection(files, "t", key, { ...body, rev: 2, items: [] }, first),
  );
  expect(await noteFiles()).toEqual([]);
  const reopened = await Effect.runPromise(readProjection(files, "t", key));
  expect(reopened?.body.items).toEqual([]);
  expect(reopened?.body.folders).toHaveLength(1);
});
