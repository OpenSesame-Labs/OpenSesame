import {
  memoryObjectStore,
  sealFile,
} from "@opensesame/vault-core/file-parts.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  checkNothingInTheClear,
  originFileValues,
} from "./at-rest-contract.mjs";

const page = { evaluate: (read, args) => read(args) };
const file = (text) => ({
  kind: "file",
  getFile: async () => ({ text: async () => text }),
});
const part = (bytes) => ({
  kind: "file",
  getFile: async () => ({
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  }),
});
const directory = (entries) => ({
  kind: "directory",
  async *entries() {
    yield* entries;
  },
  async getDirectoryHandle(name) {
    const entry = entries.find(([key]) => key === name)?.[1];
    if (entry?.kind !== "directory")
      throw new DOMException("gone", "NotFoundError");
    return entry;
  },
  async getFileHandle(name) {
    const entry = entries.find(([key]) => key === name)?.[1];
    if (entry?.kind !== "file") throw new DOMException("gone", "NotFoundError");
    return entry;
  },
});
function useRoot(root) {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
}

afterEach(() => vi.unstubAllGlobals());

it("restarts the entire snapshot if an enumerated file disappears", async () => {
  let scans = 0;
  useRoot({
    async *entries() {
      scans += 1;
      yield [
        "opensesame-pages-kept.json",
        file(scans === 1 ? "stale" : "stable"),
      ];
      if (scans === 1) {
        yield [
          "opensesame-pages-gone.json",
          {
            kind: "file",
            getFile: async () => {
              throw new DOMException("removed", "NotFoundError");
            },
          },
        ];
      }
    },
  });
  expect(await originFileValues(page)).toEqual([
    { where: "file:opensesame-pages-kept.json", text: "stable" },
  ]);
  expect(scans).toBe(3);
});

it("fails after bounded churn and propagates other filesystem failures", async () => {
  let scans = 0;
  let reason = new DOMException("removed", "NotFoundError");
  useRoot({
    async *entries() {
      scans += 1;
      yield [
        "opensesame-pages-race.json",
        {
          kind: "file",
          getFile: async () => {
            throw reason;
          },
        },
      ];
    },
  });
  await expect(originFileValues(page)).rejects.toMatchObject({
    name: "NotFoundError",
  });
  expect(scans).toBe(5);
  reason = new DOMException("denied", "NotAllowedError");
  scans = 0;
  await expect(originFileValues(page)).rejects.toMatchObject({
    name: "NotAllowedError",
  });
  expect(scans).toBe(1);
});

it("restarts when a file part disappears after it is enumerated", async () => {
  let scans = 0;
  let removed = false;
  const root = {
    async *entries() {
      scans += 1;
      yield [
        "opensesame-pages-file-parts",
        directory(removed ? [] : [["part", part(new Uint8Array([1, 2]))]]),
      ];
    },
    async getDirectoryHandle() {
      return {
        async getFileHandle() {
          removed = true;
          throw new DOMException("removed", "NotFoundError");
        },
      };
    },
  };
  useRoot(root);
  expect(await originFileValues(page)).toEqual([]);
  expect(scans).toBe(3);
});

it("restarts if a file part changes between enumeration and reading", async () => {
  let reads = 0;
  const changing = {
    kind: "file",
    async getFile() {
      reads += 1;
      const changed = reads > 1;
      return {
        size: changed ? 3 : 2,
        lastModified: changed ? 2 : 1,
        arrayBuffer: async () =>
          new Uint8Array(changed ? [1, 2, 3] : [1, 2]).buffer,
      };
    },
  };
  useRoot(
    directory([
      ["opensesame-pages-file-parts", directory([["part", changing]])],
    ]),
  );
  const values = await originFileValues(page);
  expect(values[0]).toMatchObject({
    size: 3,
    modified: 2,
    authenticated: false,
  });
  expect(reads).toBe(5);
});

it("authenticates actual AES-GCM file parts and fails closed without evidence", async () => {
  const store = memoryObjectStore();
  const manifest = JSON.parse(
    await sealFile({
      name: "synthetic.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("synthetic secret value"),
      stores: [store],
      partBytes: 8,
    }),
  );
  const entries = await Promise.all(
    manifest.parts.map(async ({ key }) => [
      key,
      part(await store.getObject(key)),
    ]),
  );
  const name = manifest.parts[0].key;
  const ciphertext = await store.getObject(name);
  const setParts = () =>
    useRoot(directory([["opensesame-pages-file-parts", directory(entries)]]));
  setParts();
  let values = await originFileValues(
    page,
    [manifest],
    ["synthetic secret value"],
  );
  expect(values).toHaveLength(manifest.parts.length);
  expect(values.every((value) => value.authenticated)).toBe(true);
  expect(values[0]).toMatchObject({
    where: `file:opensesame-pages-file-parts/${name}`,
    kind: "file-part",
  });
  expect(values.every((value) => !value.leaked)).toBe(true);
  expect(
    (await originFileValues(page)).every((value) => !value.authenticated),
  ).toBe(true);
  const stored = Uint8Array.from(ciphertext);
  stored[0] ^= 1;
  entries[0] = [name, part(stored)];
  setParts();
  values = await originFileValues(page, [manifest]);
  expect(values[0].authenticated).toBe(false);
  expect(values.slice(1).every((value) => value.authenticated)).toBe(true);
  entries[0] = [name, part(new TextEncoder().encode("synthetic secret value"))];
  setParts();
  values = await originFileValues(page, [manifest], ["synthetic secret value"]);
  expect(values[0]).toMatchObject({ authenticated: false, leaked: true });
  await expect(originFileValues(page, [manifest, manifest])).rejects.toThrow(
    "Invalid or duplicate file part verification record",
  );
  useRoot(directory([["opensesame-pages-file-parts", directory([])]]));
  await expect(originFileValues(page, [manifest])).rejects.toThrow(
    "File part verification evidence refers to a missing part",
  );
});

it("refuses unsupported owned directories instead of skipping them", async () => {
  useRoot(directory([["opensesame-pages-unknown", directory([])]]));
  await expect(originFileValues(page)).rejects.toThrow(
    "Unsupported owned origin directory",
  );
  useRoot(
    directory([
      ["opensesame-pages-file-parts", directory([["nested", directory([])]])],
    ]),
  );
  await expect(originFileValues(page)).rejects.toThrow(
    "Unsupported file part entry",
  );
});

it("detects plaintext and unauthenticated file parts without printing their contents", async () => {
  const record = `osr2.${Buffer.alloc(112).toString("base64url")}`;
  const findings = [];
  const fakePage = {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce({
        values: [{ where: "idb:vault/record", text: record }],
        keyExtractable: false,
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({
        values: [
          {
            where: "file:opensesame-pages-file-parts/test",
            kind: "file-part",
            name: "test",
          },
        ],
      })
      .mockResolvedValueOnce({ authenticated: false, leaked: true })
      .mockResolvedValueOnce({
        values: [
          {
            where: "file:opensesame-pages-file-parts/test",
            kind: "file-part",
            name: "test",
          },
        ],
      }),
  };
  await checkNothingInTheClear(
    fakePage,
    (pass, message) => findings.push({ pass, message }),
    ["synthetic secret value"],
  );
  expect(
    findings.find((entry) => entry.message.startsWith("every stored")),
  ).toMatchObject({ pass: false });
  expect(
    findings.find((entry) => entry.message.startsWith("no plaintext")),
  ).toMatchObject({ pass: false });
  expect(JSON.stringify(findings)).not.toContain("synthetic secret value");
});
