import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";

async function fixtures(root) {
  const require = createRequire(
    resolve(root, "packages/app-core/package.json"),
  );
  const sdk = require("kdbxweb");
  const files = [];
  for (const version of [3, 4]) {
    const credentials = new sdk.Credentials(
      sdk.ProtectedValue.fromString("dev password"),
    );
    const db = sdk.Kdbx.create(credentials, "Dev proof");
    if (version === 3) {
      db.setVersion(3);
      db.header.keyEncryptionRounds = 10;
    } else {
      db.setKdf(sdk.Consts.KdfId.Aes);
      db.header.kdfParameters.set(
        "R",
        sdk.VarDictionary.ValueType.UInt64,
        new sdk.Int64(10),
      );
    }
    db.createEntry(db.getDefaultGroup()).fields.set("Title", "Dev AES");
    files.push({
      bytes: [...new Uint8Array(await db.save())],
      password: "dev password",
    });
  }
  files.push({
    bytes: [
      ...(await readFile(resolve(root, "tests/fixtures/kdbx/roundtrip.kdbx"))),
    ],
    password: "correct horse battery staple",
  });
  return files;
}

function devEntry(host, importer) {
  return `
import {configureHost} from ${JSON.stringify(`/@fs${host}`)};
import {keepassKdbx} from ${JSON.stringify(`/@fs${importer}`)};
let jobs=0, argonJobs=0, terminated=0;
class TestWorker extends Worker {
  constructor(url,options) { if(new URL(url,location.href).origin!==location.origin) throw new Error('KDF worker must be same-origin'); super(url,options); }
  postMessage(work,transfer) { if(work.variant==="aes") jobs++; else argonJobs++; super.postMessage(work,transfer); }
  terminate(){terminated++;super.terminate();}
}
configureHost({env:{},worker:TestWorker});
globalThis.probe=async()=>{
  const files=await (await fetch('/fixtures')).json(), items=[];
  for(const [index,file] of files.entries()) {
    const value=await keepassKdbx.parse({fileName:'x.kdbx',text:'',headers:null,json:null,bytes:new Uint8Array(file.bytes),password:file.password});
    items.push(index<2 ? value.items[0]?.name : value.items.length);
  }
  configureHost({env:{}});
  const unsupported=[];
  for(const file of files) {
    try { await keepassKdbx.parse({fileName:'x.kdbx',text:'',headers:null,json:null,bytes:new Uint8Array(file.bytes),password:file.password}); unsupported.push(false); }
    catch(error) { unsupported.push(String(error).includes('cannot safely open')); }
  }
  return {jobs,argonJobs,terminated,items,unsupported};
};
`;
}

/** A tiny loopback Vite server with no Pages config or native build plugins. */
export async function verifyKdbxDevWorker(browser, root) {
  const directory = await mkdtemp(join(tmpdir(), "kdbx-dev-proof-"));
  let server;
  let context;
  try {
    const require = createRequire(resolve(root, "apps/pages/package.json"));
    const { createServer } = await import(
      pathToFileURL(require.resolve("vite")).href
    );
    const files = await fixtures(root);
    const host = resolve(root, "packages/app-core/src/host.ts");
    const importer = resolve(
      root,
      "packages/app-core/src/lib/vault/import/formats/kdbx.ts",
    );
    await symlink(
      resolve(root, "node_modules"),
      resolve(directory, "node_modules"),
      "dir",
    );
    await writeFile(
      resolve(directory, "index.html"),
      '<script type="module" src="/entry.js"></script>',
    );
    await writeFile(resolve(directory, "entry.js"), devEntry(host, importer));
    server = await createServer({
      configFile: false,
      root: directory,
      cacheDir: resolve(directory, "cache"),
      logLevel: "silent",
      plugins: [
        kdbxNativeDOM(root),
        {
          name: "kdbx-dev-proof-fixtures",
          configureServer(dev) {
            dev.middlewares.use("/fixtures", (_req, res) => {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify(files));
            });
          },
        },
      ],
      optimizeDeps: {
        include: [
          "@opensesame/app-core > kdbxweb",
          "@opensesame/app-core > hash-wasm",
        ],
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: {
          allow: [
            root,
            directory,
            dirname(dirname(require.resolve("hash-wasm"))),
          ],
        },
      },
    });
    await server.listen();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => Object.hasOwn(globalThis, "probe"), {
      timeout: 10_000,
    });
    assert.deepEqual(await page.evaluate(() => globalThis.probe()), {
      jobs: 2,
      argonJobs: 1,
      terminated: 3,
      items: ["Dev AES", "Dev AES", 5],
      unsupported: [true, true, true],
    });
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
