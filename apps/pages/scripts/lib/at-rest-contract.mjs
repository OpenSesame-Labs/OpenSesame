// Nothing the app stores rests in the clear (ADR 0149), measured in the real
// browser: every value of the app's Web Storage keys, every one of its
// origin-private files and every row of its IndexedDB databases (a row's
// `sealed` field, or the whole row when it has none) is an at-rest seal,
// the key that opens them cannot be exported, and none of the given
// plaintexts appears anywhere a value rests.

import { isRecordRestEnvelope } from "./at-rest-envelope-format.mjs";

/** App-owned Web Storage keys (`lib/storage-ownership.ts`). */
const OWNED = {
  prefixes: [
    "opensesame.",
    "opensesame:federation:",
    "opensesame:ambient-auth:",
  ],
  keys: [
    "opensesame:org-profile",
    "join.presented.v1",
    "join.pending.v2",
    "join.invite.v1",
  ],
};

function webStorageValues(page) {
  return page.evaluate(({ prefixes, keys }) => {
    const owned = (key) =>
      keys.includes(key) || prefixes.some((p) => key.startsWith(p));
    const values = [];
    for (const [area, store] of [
      ["local", localStorage],
      ["session", sessionStorage],
    ]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) ?? "";
        if (owned(key)) {
          values.push({ where: `${area}:${key}`, text: store.getItem(key) });
        }
      }
    }
    return values;
  }, OWNED);
}

function decodeCanonicalBase64(value, length) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Invalid file part verification data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value)
    throw new Error("Invalid file part verification data");
  return bytes;
}

function partEvidence(manifests) {
  const evidence = new Map();
  for (const manifest of manifests) {
    if (manifest?.v !== 1 || !Array.isArray(manifest.parts))
      throw new Error("Invalid file part verification manifest");
    const raw = decodeCanonicalBase64(manifest.key, 32);
    raw.fill(0);
    for (const [index, part] of manifest.parts.entries()) {
      const iv = decodeCanonicalBase64(part.nonce, 12);
      if (part.key !== iv.toString("base64url") || evidence.has(part.key))
        throw new Error("Invalid or duplicate file part verification record");
      evidence.set(part.key, {
        key: manifest.key,
        nonce: part.nonce,
        index,
        count: manifest.parts.length,
      });
    }
  }
  return evidence;
}

async function enumerateOriginFiles(page) {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const values = [];
      for await (const [name, handle] of root.entries()) {
        if (!name.startsWith("opensesame-pages-")) continue;
        if (handle.kind === "file") {
          values.push({
            where: `file:${name}`,
            text: await (await handle.getFile()).text(),
          });
          continue;
        }
        if (
          handle.kind !== "directory" ||
          name !== "opensesame-pages-file-parts"
        )
          throw new Error("Unsupported owned origin directory");
        for await (const [part, entry] of handle.entries()) {
          if (entry.kind !== "file")
            throw new Error("Unsupported file part entry");
          const file = await entry.getFile();
          values.push({
            where: `file:${name}/${part}`,
            kind: "file-part",
            name: part,
            size: file.size,
            modified: file.lastModified,
          });
        }
      }
      return { values };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return { retry: true };
      throw error;
    }
  });
}

async function readFilePart(page, name, evidence, plaintexts) {
  return page.evaluate(
    async ({ name, evidence, plaintexts }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(
          "opensesame-pages-file-parts",
        );
        const file = await (await dir.getFileHandle(name)).getFile();
        const bytes = await file.arrayBuffer();
        const text = plaintexts.length ? new TextDecoder().decode(bytes) : "";
        const leaked = plaintexts.some((needle) =>
          new RegExp(needle).test(text),
        );
        let authenticated = false;
        if (evidence) {
          const decode = (text) =>
            Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
          const raw = decode(evidence.key);
          let key;
          try {
            key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
              "decrypt",
            ]);
          } finally {
            raw.fill(0);
          }
          try {
            const plain = await crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: decode(evidence.nonce),
                additionalData: new TextEncoder().encode(
                  `${evidence.index}:${evidence.count}`,
                ),
              },
              key,
              bytes,
            );
            new Uint8Array(plain).fill(0);
            authenticated = true;
          } catch {
            // Failed authentication remains visible as an unsealed value.
          }
        }
        return {
          authenticated,
          leaked,
          size: file.size,
          modified: file.lastModified,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError")
          return { retry: true };
        throw error;
      }
    },
    { name, evidence, plaintexts },
  );
}

function originSnapshot(values) {
  return JSON.stringify(
    values
      .map((value) => [value.where, value.text, value.size, value.modified])
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

/** Snapshot app-owned files, retrying a concurrent removal of an enumerated file. */
export async function originFileValues(
  page,
  filePartManifests = [],
  plaintexts = [],
) {
  const parts = partEvidence(filePartManifests);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await enumerateOriginFiles(page);
    let retry = snapshot.retry === true;
    const values = snapshot.values ?? [];
    for (const value of values) {
      if (value.kind !== "file-part") continue;
      const result = await readFilePart(
        page,
        value.name,
        parts.get(value.name),
        plaintexts,
      );
      if (
        result.retry ||
        result.size !== value.size ||
        result.modified !== value.modified
      ) {
        retry = true;
        break;
      }
      value.authenticated = result.authenticated;
      value.leaked = result.leaked;
      delete value.name;
    }
    if (!retry) {
      const after = await enumerateOriginFiles(page);
      retry =
        after.retry === true ||
        originSnapshot(values) !== originSnapshot(after.values);
    }
    if (!retry) {
      const observed = new Set(values.map((value) => value.where));
      if (
        [...parts.keys()].some(
          (name) => !observed.has(`file:opensesame-pages-file-parts/${name}`),
        )
      )
        throw new Error(
          "File part verification evidence refers to a missing part",
        );
      return values;
    }
    if (attempt < 4)
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
  }
  throw new DOMException("Origin files did not settle", "NotFoundError");
}

function indexedDbValues(page) {
  return page.evaluate(async () => {
    const settle = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const values = [];
    let keyExtractable = null;
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith("opensesame-")) continue;
      const db = await settle(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        const rows = await settle(
          db.transaction(store).objectStore(store).getAll(),
        );
        for (const row of rows) {
          if (name === "opensesame-at-rest") {
            keyExtractable = row.wrappingKey?.extractable ?? null;
            continue;
          }
          const text = String(row.sealed ?? JSON.stringify(row));
          values.push({ where: `idb:${name}/${store}/${row.id}`, text });
        }
      }
      db.close();
    }
    return { values, keyExtractable };
  });
}

/**
 * @param {import("playwright").Page} page
 * @param {(ok: boolean, detail: string) => void} check
 * @param {string[]} plaintexts regex sources that must match no stored value
 * @param {string[]} present places (`local:<key>`, `file:<name>`) that must
 *   hold a value, so a check cannot pass by finding nothing there
 * @param {object[]} filePartManifests synthetic manifests used to authenticate
 *   AES-GCM file parts; unreferenced or invalid parts fail the seal check
 */
export async function checkNothingInTheClear(
  page,
  check,
  plaintexts = [],
  present = [],
  filePartManifests = [],
) {
  const idb = await indexedDbValues(page);
  const values = [
    ...(await webStorageValues(page)),
    ...(await originFileValues(page, filePartManifests, plaintexts)),
    ...idb.values,
  ];
  const where = (list) => list.map((value) => value.where).join(", ");
  const clear = values.filter((value) =>
    value.kind === "file-part"
      ? value.authenticated !== true
      : !isRecordRestEnvelope(value.text),
  );
  const leaked = values.filter((value) =>
    value.kind === "file-part"
      ? value.leaked === true
      : plaintexts.some((needle) =>
          new RegExp(needle).test(String(value.text)),
        ),
  );
  check(values.length > 0, `the app stored something (${values.length})`);
  for (const place of present) {
    check(
      values.some((value) => value.where === place),
      `${place} is stored`,
    );
  }
  check(clear.length === 0, `every stored value is sealed ${where(clear)}`);
  check(leaked.length === 0, `no plaintext rests anywhere ${where(leaked)}`);
  check(
    idb.keyExtractable === false,
    "the at-rest key is kept and cannot be exported",
  );
}
