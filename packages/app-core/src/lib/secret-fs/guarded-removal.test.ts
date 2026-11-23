import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { Effect, FileSystem, Redacted } from "effect";
import { expect, it } from "vitest";
import { SecretFsUnavailable } from "./errors.js";
import { failureOf } from "./files.conformance.js";
import { type SecretFiles, revisionOf } from "./files.js";
import { makeFileSystemSecretFiles } from "./filesystem.js";
import { makeMemorySecretFiles } from "./memory.js";
import { resilient } from "./resilient.js";
import { makeS3SecretFiles } from "./s3.js";
import {
  ACCESS_KEY,
  BUCKET_NAME,
  ENDPOINT,
  REGION,
  SECRET_KEY,
  fakeBucket,
} from "./s3.test-support.js";

const bytes = (value: string) => new TextEncoder().encode(value);

it("refuses an expired memory owner and preserves conditional removal", async () => {
  const files = makeMemorySecretFiles();
  const remove = files.removeGuarded;
  if (!remove) throw new Error("Missing guarded memory removal");
  const revision = await Effect.runPromise(
    files.write("owned.json", bytes("one")),
  );
  const stale = await failureOf(
    remove("owned.json", () => {
      throw new Error("Original owner ended");
    }),
  );
  expect(stale).toMatchObject({ _tag: "SecretFsRejected", kind: "permission" });
  expect(files.snapshot().has("owned.json")).toBe(true);
  expect(
    await failureOf(
      remove("missing.json", () => {
        throw new Error("Original owner ended");
      }),
    ),
  ).toMatchObject({ _tag: "SecretFsRejected", kind: "permission" });
  await Effect.runPromise(files.write("owned.json", bytes("two")));
  expect(
    await failureOf(
      remove(
        "owned.json",
        () => {
          throw new Error("Original owner ended");
        },
        { ifRevision: revision },
      ),
    ),
  ).toMatchObject({ _tag: "SecretFsRejected", kind: "permission" });
  expect(
    (await failureOf(remove("owned.json", () => {}, { ifRevision: revision })))
      ._tag,
  ).toBe("SecretFsConflict");
  expect(files.snapshot().has("owned.json")).toBe(true);
  await Effect.runPromise(remove("owned.json", () => {}));
  expect(files.snapshot().has("owned.json")).toBe(false);
});

it.each(["remove", "write", "write preflight"] as const)(
  "rechecks directory ownership when it ends during %s",
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "guarded-removal-"));
    let withdraw = false;
    let live = true;
    try {
      const files = await Effect.runPromise(
        Effect.gen(function* () {
          const actual = yield* FileSystem.FileSystem;
          const wrapped = {
            ...actual,
            readFile: (...args: Parameters<typeof actual.readFile>) =>
              actual.readFile(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const boundary =
                      operation === "write preflight" ? "/owned.json" : ".lock";
                    if (withdraw && String(args[0]).endsWith(boundary))
                      live = false;
                  }),
                ),
              ),
          };
          return yield* makeFileSystemSecretFiles(root).pipe(
            Effect.provideService(FileSystem.FileSystem, wrapped),
          );
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      const revision = await Effect.runPromise(
        files.write("owned.json", bytes("one")),
      );
      const remove = files.removeGuarded;
      const write = files.writeGuarded;
      if (!remove || !write)
        throw new Error("Missing guarded directory operation");
      withdraw = true;
      const check = () => {
        if (!live) throw new Error("Original owner ended");
      };
      const error = await failureOf(
        operation === "remove"
          ? remove("owned.json", check, { ifRevision: revision })
          : write("owned.json", bytes("two"), check, {
              ifRevision:
                operation === "write preflight"
                  ? revisionOf(bytes("stale"))
                  : revision,
            }).pipe(Effect.asVoid),
      );
      expect(live).toBe(false);
      expect(error).toMatchObject({
        _tag: "SecretFsRejected",
        kind: "permission",
      });
      expect(await readFile(join(root, "owned.json"), "utf8")).toBe("one");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["preflight", "signing"] as const)(
  "prevents S3 DELETE when ownership ends during %s",
  async (boundary) => {
    const bucket = fakeBucket();
    let withdraw = false;
    let live = true;
    const files = makeS3SecretFiles({
      endpoint: ENDPOINT,
      region: REGION,
      bucket: BUCKET_NAME,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: Redacted.make(SECRET_KEY),
      },
      now: () => {
        if (withdraw && boundary === "signing") live = false;
        return new Date();
      },
      fetch: async (input, init) => {
        const response = await bucket.fetch(input, init);
        if (withdraw && boundary === "preflight" && init?.method === "GET")
          live = false;
        return response;
      },
    });
    const revision = await Effect.runPromise(
      files.write("owned.json", bytes("one")),
    );
    const remove = files.removeGuarded;
    if (!remove) throw new Error("Missing guarded S3 removal");
    bucket.log.length = 0;
    withdraw = true;
    const error = await failureOf(
      remove(
        "owned.json",
        () => {
          if (!live) throw new Error("Original owner ended");
        },
        boundary === "preflight" ? { ifRevision: revision } : undefined,
      ),
    );
    expect(error).toMatchObject({
      _tag: "SecretFsRejected",
      kind: "permission",
    });
    expect(bucket.log.some((entry) => entry.startsWith("DELETE "))).toBe(false);
    expect(bucket.objects.has("owned.json")).toBe(true);
  },
);

it("keeps a newer S3 object when it changes between conditional read and delete", async () => {
  const bucket = fakeBucket();
  let race = false;
  const replacement = bytes("newer");
  const files = makeS3SecretFiles({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET_NAME,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: Redacted.make(SECRET_KEY),
    },
    fetch: async (input, init) => {
      const response = await bucket.fetch(input, init);
      if (race && init?.method === "GET") {
        race = false;
        bucket.objects.set("owned.json", {
          bytes: replacement,
          etag: '"newer"',
        });
      }
      return response;
    },
  });
  const revision = await Effect.runPromise(
    files.write("owned.json", bytes("one")),
  );
  const remove = files.removeGuarded;
  if (!remove) throw new Error("Missing guarded S3 removal");
  race = true;
  expect(
    await failureOf(remove("owned.json", () => {}, { ifRevision: revision })),
  ).toMatchObject({
    _tag: "SecretFsConflict",
    expected: revision,
    actual: revisionOf(replacement),
  });
  expect(bucket.objects.get("owned.json")?.bytes).toEqual(replacement);
  await Effect.runPromise(
    remove("owned.json", () => {}, { ifRevision: revisionOf(replacement) }),
  );
  expect(bucket.objects.has("owned.json")).toBe(false);
  await Effect.runPromise(
    remove("owned.json", () => {}, { ifRevision: revision }),
  );
});

it("does not retry guarded removal after ownership ends", async () => {
  const inner = makeMemorySecretFiles();
  const original = inner.removeGuarded?.bind(inner);
  if (!original) throw new Error("Missing guarded removal fixture");
  await Effect.runPromise(inner.write("owned.json", bytes("one")));
  let live = true;
  let attempts = 0;
  const flaky: SecretFiles = {
    ...inner,
    removeGuarded: (path, check, options) =>
      Effect.suspend(() => {
        attempts += 1;
        if (attempts > 1) return original(path, check, options);
        live = false;
        return Effect.fail(
          new SecretFsUnavailable({ path, reason: "offline" }),
        );
      }),
  };
  const files = await Effect.runPromise(
    resilient(flaky, { retries: 2, backoff: "1 millis" }),
  );
  const remove = files.removeGuarded;
  if (!remove) throw new Error("Resilience lost guarded removal");
  const error = await failureOf(
    remove("owned.json", () => {
      if (!live) throw new Error("Original owner ended");
    }),
  );
  expect(error).toMatchObject({ _tag: "SecretFsRejected", kind: "permission" });
  expect(attempts).toBe(1);
  expect(inner.snapshot().has("owned.json")).toBe(true);
});

it("passes the revision through a guarded retry", async () => {
  const inner = makeMemorySecretFiles();
  const original = inner.removeGuarded?.bind(inner);
  if (!original) throw new Error("Missing guarded removal fixture");
  const staleRevision = await Effect.runPromise(
    inner.write("owned.json", bytes("old")),
  );
  const actualRevision = await Effect.runPromise(
    inner.write("owned.json", bytes("new")),
  );
  let attempts = 0;
  const flaky: SecretFiles = {
    ...inner,
    removeGuarded: (path, check, options) =>
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "offline" }))
          : original(path, check, options);
      }),
  };
  const files = await Effect.runPromise(
    resilient(flaky, { retries: 2, backoff: "1 millis" }),
  );
  const remove = files.removeGuarded;
  if (!remove) throw new Error("Resilience lost guarded removal");
  expect(
    await failureOf(
      remove("owned.json", () => {}, { ifRevision: staleRevision }),
    ),
  ).toMatchObject({
    _tag: "SecretFsConflict",
    expected: staleRevision,
    actual: actualRevision,
  });
  expect(attempts).toBe(2);
  expect(inner.snapshot().has("owned.json")).toBe(true);
  await Effect.runPromise(
    remove("owned.json", () => {}, { ifRevision: actualRevision }),
  );
  expect(inner.snapshot().has("owned.json")).toBe(false);
});

it("does not advertise guarded removal when the wrapped backend lacks it", async () => {
  const { removeGuarded: _unsupported, ...files } = makeMemorySecretFiles();
  const wrapped = await Effect.runPromise(resilient(files));
  expect(wrapped.removeGuarded).toBeUndefined();
});

it("keeps guarded removal available when the wrapped backend lacks guarded writes", async () => {
  const { writeGuarded: _unsupported, ...files } = makeMemorySecretFiles();
  const wrapped = await Effect.runPromise(resilient(files));
  expect(wrapped.writeGuarded).toBeUndefined();
  expect(wrapped.removeGuarded).toBeTypeOf("function");
});
