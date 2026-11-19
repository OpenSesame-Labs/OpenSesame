import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as aesWorker from "./kdbx-aes-worker-proof.mjs";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";

const root =
  process.env.PAGES_KDBX_TEST_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "apps/pages/package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = require("@playwright/test");
const coreRequire = createRequire(
  resolve(root, "packages/app-core/package.json"),
);
const entry = `
import * as sdk from ${JSON.stringify(coreRequire.resolve("kdbxweb"))};
import { configureHost } from ${JSON.stringify(resolve(root, "packages/app-core/src/host.ts"))};
import { argon2d, argon2id } from ${JSON.stringify(coreRequire.resolve("hash-wasm"))};
import { keepassKdbx } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx.ts"))};
import { isolatedArgon2 } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx-argon2-worker-client.ts"))};
let workersStarted = 0, workersStopped = 0;
class TrackedWorker extends Worker {
  constructor(url, options) { super(url, options); workersStarted++; }
  terminate() { workersStopped++; super.terminate(); }
}
configureHost({ env: {}, worker: TrackedWorker });
globalThis.kdbxSDK = sdk;
globalThis.importKdbxFixture = (fixture) => keepassKdbx.parse({
  fileName:"roundtrip.kdbx",text:"",headers:null,json:null,bytes:new Uint8Array(fixture),password:"correct horse battery staple"
});
globalThis.runKdbxProof = async (fixture) => {
  const pass = "browser-roundtrip";
  const credentials = (value) => new sdk.Credentials(sdk.ProtectedValue.fromString(value));
  const db = sdk.Kdbx.create(credentials(pass), "Native XML");
  db.setVersion(3);
  db.header.keyEncryptionRounds = 10;
  const item = db.createEntry(db.getDefaultGroup());
  item.fields.set("Title", "Native <XML> & Unicode 雪\\tTab");
  item.fields.set("UserName", "reader\\there\\rreturns");
  item.fields.set("Notes", "__KDBX_CR_0__\\r\\nsecond");
  item.fields.set("Password", sdk.ProtectedValue.fromString("protected-roundtrip"));
  const saved = await db.save();
  const loaded = await sdk.Kdbx.load(saved.slice(0), credentials(pass));
  const restored = loaded.getDefaultGroup().entries[0];
  const input = (bytes, password) => ({fileName:"roundtrip.kdbx",text:"",headers:null,json:null,bytes:new Uint8Array(bytes),password});
  const parsed = await keepassKdbx.parse(input(saved, pass));
  const rejected = async (operation) => {try {await operation();return false;}catch{return true;}};
  const corrupt = new Uint8Array(saved.slice(0));
  corrupt[corrupt.length - 1] ^= 1;
  let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 0);
  const external = await keepassKdbx.parse(input(new Uint8Array(fixture).buffer, "correct horse battery staple"));
  clearInterval(heartbeat);
  const password = new TextEncoder().encode("  Pässe\u0301🔐  ");
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(" Mixed.Case+salt@Example.test ")));
  const options = { password, salt, memorySize: 16384, iterations: 2, parallelism: 1, hashLength: 32, outputType: "binary" };
  const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const workerArgon2d = hex(await isolatedArgon2.argon2d(options));
  const workerArgon2id = hex(await isolatedArgon2.argon2id(options));
  // Change only the unauthenticated outer header. A vulnerable reader starts
  // the attacker-selected work before it can reject the invalid header MAC.
  const hostileRounds = (source, major) => {
    const bytes = new Uint8Array(source.slice(0));
    const view = new DataView(bytes.buffer);
    let cursor = 12;
    while (cursor < bytes.length) {
      const id = view.getUint8(cursor++);
      const size = major === 3 ? view.getUint16(cursor, true) : view.getUint32(cursor, true);
      cursor += major === 3 ? 2 : 4;
      if (major === 3 && id === 6) { view.setBigUint64(cursor, 1n << 40n, true); return bytes; }
      if (major === 4 && id === 11) {
        let p = cursor + 2;
        while (bytes[p] !== 0) {
          p++;
          const nameSize = view.getUint32(p, true); p += 4;
          const name = new TextDecoder().decode(bytes.subarray(p, p + nameSize)); p += nameSize;
          const valueSize = view.getUint32(p, true); p += 4;
          if (name === "R") { view.setBigUint64(p, 1n << 40n, true); return bytes; }
          p += valueSize;
        }
      }
      cursor += size;
    }
    throw new Error("fixture lacks AES rounds");
  };
  const tooManyRounds = async (bytes) => {
    try { await keepassKdbx.parse(input(bytes, pass)); return false; }
    catch (error) { return String(error).includes("work budget"); }
  };
  const aesV4 = sdk.Kdbx.create(credentials(pass), "AES database");
  aesV4.setKdf(sdk.Consts.KdfId.Aes);
  aesV4.header.kdfParameters.set("R", sdk.VarDictionary.ValueType.UInt64, new sdk.Int64(10));
  const savedV4 = await aesV4.save();
  await keepassKdbx.parse(input(savedV4, pass));
  const unsafeV3 = await tooManyRounds(hostileRounds(saved, 3));
  const unsafeV4 = await tooManyRounds(hostileRounds(savedV4, 4));
  const xmlDoc = sdk.XmlUtils.parse("<Root><V/></Root>");
  xmlDoc.documentElement.setAttribute("value", "attr\\r\\t\\nend");
  xmlDoc.getElementsByTagName("V")[0].textContent = "__KDBX_CR_T_0__\\rtext";
  xmlDoc.documentElement.appendChild(xmlDoc.createCDATASection("__KDBX_CR_C_0__\\r&<"));
  const xmlRoundTrip = sdk.XmlUtils.parse(sdk.XmlUtils.serialize(xmlDoc));
  // Generate with the released UMD and read with the tree-shaken source: this
  // catches format, key-derivation and protected-value compatibility changes.
  sdk.CryptoEngine.setArgon2Impl(async (password,salt,memory,iterations,length,parallelism,type)=>{
    const fn=type===sdk.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
    const bytes=await fn({password:new Uint8Array(password),salt:new Uint8Array(salt),parallelism,iterations,memorySize:memory,hashLength:length,outputType:"binary"});
    return new Uint8Array(bytes).buffer;
  });
  const v4=[];
  for (const kdf of [sdk.Consts.KdfId.Argon2d,sdk.Consts.KdfId.Argon2id,sdk.Consts.KdfId.Aes]) {
    const db4=sdk.Kdbx.create(credentials(pass),"four");
    db4.setKdf(kdf);
    db4.header.kdfParameters.set("M",sdk.VarDictionary.ValueType.UInt64,new sdk.Int64(4*1024*1024));
    db4.header.kdfParameters.set("I",sdk.VarDictionary.ValueType.UInt64,new sdk.Int64(1));
    db4.header.kdfParameters.set("R",sdk.VarDictionary.ValueType.UInt64,new sdk.Int64(10));
    const child=db4.createGroup(db4.getDefaultGroup(),"Nested");
    const item4=db4.createEntry(child);
    item4.fields.set("Title","v4 secret");
    item4.fields.set("Password",sdk.ProtectedValue.fromString("v4 password"));
    item4.binaries.set("attachment.bin",new Uint8Array([1,2,3]).buffer);
    const saved4=await db4.save();
    const parsed4=await keepassKdbx.parse(input(saved4,pass));
    const wrong4=await rejected(()=>keepassKdbx.parse(input(saved4,"wrong")));
    const corrupt4=new Uint8Array(saved4.slice(0)); corrupt4[corrupt4.length-1]^=1;
    const bad4=await rejected(()=>keepassKdbx.parse(input(corrupt4.buffer,pass)));
    v4.push({items:parsed4.items,warnings:parsed4.warnings,wrong4,bad4});
  }
  configureHost({ env: {} });
  const noWorker = await rejected(() => keepassKdbx.parse(input(new Uint8Array(fixture).buffer, "correct horse battery staple")));
  return {
    v4,
    xmlAttribute: xmlRoundTrip.documentElement.getAttribute("value"),
    xmlText: xmlRoundTrip.documentElement.textContent,
    native: typeof DOMParser === "function" && typeof XMLSerializer === "function" && !!crypto.subtle,
    magic: new DataView(saved).getUint32(0,true),
    title: restored.fields.get("Title"),
    protected: restored.fields.get("Password") instanceof sdk.ProtectedValue,
    secret: restored.fields.get("Password").getText(),
    parsed,
    wrongPassword: await rejected(() => sdk.Kdbx.load(saved.slice(0),credentials("wrong"))),
    corruption: await rejected(() => sdk.Kdbx.load(corrupt.buffer,credentials(pass))),
    importerWrongPassword: await rejected(() => keepassKdbx.parse(input(saved,"wrong"))),
    importerCorruption: await rejected(() => keepassKdbx.parse(input(corrupt.buffer,pass))),
    malformedXML: await rejected(() => sdk.XmlUtils.parse("<Root><missing></Root>")),
    externalCount: external.items.length,
    externalSecrets: external.items.filter((draft) => draft.kind === "account").map((draft) => draft.password),
    workersStarted, workersStopped, heartbeats, noWorker, argon2d:workerArgon2d, argon2id:workerArgon2id, unsafeV3, unsafeV4,
  };
};
globalThis.kdbxDeadlineProof = async () => {
  let terminated = 0, heartbeats = 0;
  class HangingWorker extends Worker {
    constructor(_url, options) { super("/hanging-worker.mjs", options); }
    terminate() { terminated++; super.terminate(); }
  }
  configureHost({ env: {}, worker: HangingWorker });
  const actualTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    actualTimeout(callback, delay === 30000 ? 100 : delay, ...args);
  const heartbeat = setInterval(() => heartbeats++, 10);
  try {
    await isolatedArgon2.argon2id({
      password: new Uint8Array(32), salt: new Uint8Array(32),
      memorySize: 1024, iterations: 1, parallelism: 1, hashLength: 32,
      outputType: "binary",
    });
    return { error: "unexpected success", terminated, heartbeats };
  } catch (error) {
    return { error: String(error), terminated, heartbeats };
  } finally {
    globalThis.setTimeout = actualTimeout;
    clearInterval(heartbeat);
  }
};
${aesWorker.kdbxAesProofEntry(root)}`;

async function buildProofChunks() {
  const built = await build({
    root: resolve(root, "apps/pages"),
    configFile: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph(),
      kdbxNativeDOM(root),
      {
        name: "owned-kdbx-browser-entry",
        resolveId: (id) => (id === "kdbx-proof" ? "\0kdbx-proof" : null),
        load: (id) => (id === "\0kdbx-proof" ? entry : null),
      },
    ],
    build: {
      write: false,
      target: "es2022",
      minify: false,
      rollupOptions: {
        input: "kdbx-proof",
        output: { format: "es" },
      },
    },
  });
  const chunks = built.output.filter((output) => output.type === "chunk");
  const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules));
  assert(modules.some((id) => id.endsWith("kdbx-native-dom.ts")));
  assert(modules.some((id) => id.includes("kdbxweb/dist/kdbxweb.js")));
  assert(modules.some((id) => id.includes("kdbxweb/lib/format/kdbx.ts")));
  assert(!modules.some((id) => id.includes("@xmldom")));
  const owner = chunks.find((chunk) =>
    Object.keys(chunk.modules).some((id) =>
      id.endsWith("kdbx-argon2-worker-client.ts"),
    ),
  );
  const worker = built.output.find(
    (output) =>
      output.type === "asset" && /kdbx-argon2\.worker/.test(output.fileName),
  );
  const workerCrypto = chunks.find(
    (chunk) =>
      Object.keys(chunk.modules).some((id) =>
        id.includes("/node_modules/hash-wasm/"),
      ) && owner?.viteMetadata?.importedAssets?.has(chunk.fileName),
  );
  assert(
    worker &&
      workerCrypto &&
      owner?.viteMetadata?.importedAssets?.has(worker.fileName),
  );
  return built.output;
}

function proofServer(outputs) {
  const chunk = outputs.find(
    (output) => output.type === "chunk" && output.isEntry,
  );
  return createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'",
    );
    if (request.url === "/hanging-worker.mjs") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("onmessage = () => { while (true) {} };");
    } else {
      const asset = outputs.find(
        (output) => `/${output.fileName}` === request.url,
      );
      if (asset) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(asset.type === "asset" ? asset.source : asset.code);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><script type="module" src="/${chunk.fileName}"></script>`,
      );
    }
  });
}

function assertProof(result) {
  assert.equal(result.v4.length, 3);
  for (const item of result.v4) {
    assert.equal(item.items[0].name, "v4 secret");
    assert.equal(item.items[0].password, "v4 password");
    assert.equal(item.items[0].folder, "Nested");
    assert.deepEqual(item.warnings, [
      "1 attachment was left behind. This vault stores fields, not files.",
    ]);
    assert.equal(item.wrong4, true);
    assert.equal(item.bad4, true);
  }
  assert.equal(result.xmlAttribute, "attr\r\t\nend");
  assert.equal(result.xmlText, "__KDBX_CR_T_0__\rtext__KDBX_CR_C_0__\r&<");
  assert.equal(result.native, true);
  assert.equal(result.magic, 0x9aa2d903);
  assert.equal(result.title, "Native <XML> & Unicode 雪\tTab");
  assert.equal(result.protected, true);
  assert.equal(result.secret, "protected-roundtrip");
  assert.equal(result.parsed.items[0].name, "Native <XML> & Unicode 雪_Tab");
  assert.equal(result.parsed.items[0].username, "reader\there\rreturns");
  assert.equal(result.parsed.items[0].notes, "__KDBX_CR_0__\r\nsecond");
  assert.equal(result.parsed.items[0].password, result.secret);
  for (const key of [
    "wrongPassword",
    "corruption",
    "importerWrongPassword",
    "importerCorruption",
    "malformedXML",
  ])
    assert.equal(result[key], true, key);
  assert(result.externalCount >= 3);
  assert(result.externalSecrets.includes("fixture-password-one"));
  assert(result.workersStarted >= 1);
  assert.equal(result.workersStarted, result.workersStopped);
  assert(result.heartbeats > 0);
  assert.equal(result.noWorker, true);
  assert.equal(result.unsafeV3, true);
  assert.equal(result.unsafeV4, true);
  assert.equal(
    result.argon2d,
    "795227f5a36af437371d33ab704dab8a9a03c1f810547c006c8d2b48e107babb",
  );
  assert.equal(
    result.argon2id,
    "1072b2ab89197fe4d3f045d8de896beca52daccc98b5d86be47bd6aa05975988",
  );
}

async function assertMissingNativeDom(browser, origin, fixture) {
  for (const missing of ["DOMParser", "XMLSerializer"]) {
    const context = await browser.newContext();
    try {
      await context.addInitScript((name) => {
        delete globalThis[name];
      }, missing);
      const unsupported = await context.newPage();
      await unsupported.goto(origin);
      await unsupported.waitForFunction(() => !!globalThis.kdbxSDK);
      const message = await unsupported.evaluate((name) => {
        try {
          if (name === "DOMParser")
            globalThis.kdbxSDK.XmlUtils.parse("<Root/>");
          else
            globalThis.kdbxSDK.XmlUtils.serialize(
              new DOMParser().parseFromString("<Root/>", "application/xml"),
            );
          return null;
        } catch (error) {
          return String(error);
        }
      }, missing);
      assert.match(
        message,
        new RegExp(`requires a browser document with native ${missing}`),
      );
      if (missing === "DOMParser") {
        const importError = await unsupported.evaluate(async (bytes) => {
          try {
            await globalThis.importKdbxFixture(bytes);
            return null;
          } catch (error) {
            return String(error);
          }
        }, fixture);
        assert.match(
          importError,
          /KdbxImportError: That database could not be read/,
        );
      }
    } finally {
      await context.close();
    }
  }
}

test("real Chromium native XML preserves encrypted KDBX import and integrity", {
  timeout: 60000,
}, async () => {
  let browser;
  let server;
  try {
    server = proofServer(await buildProofChunks());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(origin);
    const fixture = [
      ...readFileSync(resolve(root, "tests/fixtures/kdbx/roundtrip.kdbx")),
    ];
    assertProof(
      await page.evaluate((bytes) => globalThis.runKdbxProof(bytes), fixture),
    );
    const deadline = await page.evaluate(() => globalThis.kdbxDeadlineProof());
    assert.match(deadline.error, /took too long/);
    assert.equal(deadline.terminated, 1);
    assert(deadline.heartbeats > 0);
    const aesProof = await page.evaluate(() => globalThis.kdbxAesWorkerProof());
    aesWorker.assertKdbxAesProof(aesProof);
    await aesWorker.verifyKdbxDevWorker(browser, root);
    await assertMissingNativeDom(browser, origin, fixture);
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});
