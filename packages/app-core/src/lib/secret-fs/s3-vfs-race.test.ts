import {
  createItem,
  emptyBody,
  mintVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { BODY_PATH } from "../vfs.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import { makeS3SecretFiles } from "./s3.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";
import { createFileBackedVfs } from "./vfs-files.js";

it("does not overwrite a rival document when retrying a failed S3 projection", async () => {
  const bucket = fakeBucket();
  let hideEtags = false;
  let releaseRival = () => {};
  const rivalMayCommit = new Promise<void>((resolve) => {
    releaseRival = resolve;
  });
  let notifyRival = () => {};
  const rivalAtManifest = new Promise<void>((resolve) => {
    notifyRival = resolve;
  });
  let rivalCommitted = Promise.resolve();
  const config = {
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET_NAME,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: Redacted.make(SECRET_KEY),
    },
  };
  const ownerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      hideEtags &&
      request.method === "PUT" &&
      request.url.endsWith("/vault.json")
    )
      await rivalCommitted;
    const response = await bucket.fetch(request);
    if (
      hideEtags &&
      request.method === "PUT" &&
      request.url.includes("/secrets/")
    )
      releaseRival();
    if (
      !hideEtags ||
      request.method !== "GET" ||
      !request.url.endsWith("/vault.json")
    )
      return response;
    const headers = new Headers(response.headers);
    headers.delete("etag");
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers,
    });
  };
  const rivalFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "PUT" && request.url.endsWith("/vault.json")) {
      notifyRival();
      await rivalMayCommit;
    }
    return bucket.fetch(request);
  };
  const owner = makeS3SecretFiles({ ...config, fetch: ownerFetch });
  const rival = makeS3SecretFiles({ ...config, fetch: rivalFetch });
  const plain = makeS3SecretFiles({ ...config, fetch: bucket.fetch });
  const { vaultKey } = await mintVaultKey();
  const item = { ...createItem("note", "a"), id: "id-a", notes: "initial" };
  const body = { ...emptyBody(), rev: 1, items: [item] };
  const vfs = createFileBackedVfs(owner);
  await vfs.hydrate();
  const bodyKey = `tomb/t/${BODY_PATH}`;
  const seal = async (value: typeof body) =>
    JSON.stringify(
      await sealJson(vaultKey, value, vaultSealBinding("t", BODY_PATH)),
    );
  await vfs.seams.writeRaw(bodyKey, await seal(body), vaultKey);
  const state = await Effect.runPromise(readProjection(plain, "t", vaultKey));
  if (!state) throw new Error("Missing initial projection");
  const ownerBody = { ...body, rev: 2, items: [{ ...item, notes: "owner" }] };
  const rivalBody = { ...body, rev: 2, items: [{ ...item, notes: "rival" }] };
  hideEtags = true;
  await expect(
    vfs.seams.writeRaw(bodyKey, await seal(ownerBody), vaultKey),
  ).rejects.toMatchObject({ _tag: "SecretFsRejected", kind: "unsupported" });
  const rivalWrite = Effect.runPromise(
    writeProjection(rival, "t", vaultKey, rivalBody, state.state),
  );
  rivalCommitted = rivalWrite.then(() => undefined);
  try {
    await rivalAtManifest;
    const retry = vfs.seams
      .writeRaw(bodyKey, await seal(ownerBody), vaultKey)
      .finally(releaseRival);
    const [result, committed] = await Promise.allSettled([retry, rivalWrite]);
    expect(result?.status).toBe("rejected");
    expect(committed?.status).toBe("fulfilled");
    expect(
      (await Effect.runPromise(readProjection(plain, "t", vaultKey)))?.body
        .items[0]?.notes,
    ).toBe("rival");
  } finally {
    releaseRival();
  }
});
