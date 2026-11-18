import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";

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
import { argon2d, argon2id } from ${JSON.stringify(coreRequire.resolve("hash-wasm"))};
import { keepassKdbx } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx.ts"))};
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
  const external = await keepassKdbx.parse(input(new Uint8Array(fixture).buffer, "correct horse battery staple"));
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
  };
};
`;

async function buildProofChunks() {
  const built = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
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
        output: { format: "es", inlineDynamicImports: true },
      },
    },
  });
  const chunks = built.output.filter((output) => output.type === "chunk");
  assert.equal(chunks.length, 1);
  const modules = Object.keys(chunks[0].modules);
  assert(modules.some((id) => id.endsWith("kdbx-native-dom.ts")));
  assert(modules.some((id) => id.includes("kdbxweb/dist/kdbxweb.js")));
  assert(modules.some((id) => id.includes("kdbxweb/lib/format/kdbx.ts")));
  assert(!modules.some((id) => id.includes("@xmldom")));
  return chunks;
}

async function verifyUnavailableDOM(browser, origin, fixture) {
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
    const chunks = await buildProofChunks();
    server = createServer((request, response) => {
      if (request.url === "/proof.mjs") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(chunks[0].code);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><script type="module" src="/proof.mjs"></script>',
        );
      }
    });
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
    const result = await page.evaluate(
      (bytes) => globalThis.runKdbxProof(bytes),
      fixture,
    );
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
    await verifyUnavailableDOM(browser, origin, fixture);
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});
