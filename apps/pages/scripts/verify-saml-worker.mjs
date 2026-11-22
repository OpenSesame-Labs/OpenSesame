/** Run with `node apps/pages/scripts/verify-saml-worker.mjs`. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(resolve(root, "package.json"));
const { chromium } = require("@playwright/test");
const { build, loadConfigFromFile } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const callback = "assets/native-saml-Abcd1234.js";

async function workerSource() {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    resolve(root, "vite.sw-push.config.ts"),
    root,
  );
  if (!loaded) throw new Error("Cannot load worker build configuration");
  const config = loaded.config;
  const result = await build({
    ...config,
    root,
    configFile: false,
    logLevel: "silent",
    define: {
      ...config.define,
      "self.__WB_MANIFEST": JSON.stringify([
        { url: "index.html", revision: "test123" },
        { url: callback, revision: null },
      ]),
    },
    build: {
      ...config.build,
      write: false,
      rollupOptions: {
        ...config.build.rollupOptions,
        input: resolve(root, "src/sw.ts"),
        output: { format: "es", inlineDynamicImports: true },
      },
    },
  });
  const chunks = result.output.filter((item) => item.type === "chunk");
  assert.equal(chunks.length, 1);
  return chunks[0].code;
}

function serveWorker(source) {
  return createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      response.end(source);
    } else if (request.url === `/${callback}`) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("export {};");
    } else if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>owner</title><body>owner</body>");
    } else {
      response.writeHead(404);
      response.end("missing");
    }
  });
}

async function rpc(page, command) {
  return page.evaluate(
    (value) =>
      new Promise((done) => {
        const ports = new MessageChannel();
        const timer = setTimeout(() => done({ timeout: true }), 2500);
        ports.port1.onmessage = (event) => {
          clearTimeout(timer);
          ports.port1.close();
          done(event.data);
        };
        navigator.serviceWorker.controller.postMessage(value, [ports.port2]);
      }),
    command,
  );
}

async function postForm(page, nonce) {
  const pending = page.waitForEvent("popup");
  await page.evaluate((value) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/auth/native-saml";
    form.target = "_blank";
    for (const [name, content] of Object.entries({
      RelayState: value,
      SAMLResponse: btoa("<Response/>"),
    })) {
      const field = document.createElement("input");
      field.name = name;
      field.value = content;
      form.append(field);
    }
    document.body.append(form);
    form.submit();
  }, nonce);
  const popup = await pending;
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
  );
  return popup;
}

async function verifyCustody(page, origin) {
  const nonce = "A".repeat(43);
  const publicKey = "B".repeat(87);
  const arm = {
    kind: "SAML_ARM",
    nonce,
    requestId: "_request",
    expiresAt: Date.now() + 30000,
    idpOrigin: origin,
    publicKey,
  };
  assert.deepEqual(await rpc(page, { ...arm, idpOrigin: ` ${origin} ` }), {
    ok: true,
  });
  assert.deepEqual(await rpc(page, arm), { ok: false, reason: "denied" });
  const popup = await postForm(page, nonce);
  assert.equal(await popup.title(), "SAML sign-in");
  const metadata = await rpc(popup, { kind: "SAML_METADATA" });
  assert.equal(metadata.ok, true);
  assert.equal(metadata.record.nonce, nonce);
  assert.equal(metadata.record.requestId, "_request");
  assert.equal(metadata.record.publicKey, publicKey);
  const recordId = metadata.record.recordId;
  assert.deepEqual(
    await rpc(page, { kind: "SAML_CLAIM", nonce: "X".repeat(43), recordId }),
    { ok: false, reason: "denied" },
  );
  const claim = await rpc(page, { kind: "SAML_CLAIM", nonce, recordId });
  assert.equal(claim.ok, true);
  const consume = await rpc(popup, { kind: "SAML_CONSUME", nonce, recordId });
  assert.equal(consume.ok, true);
  assert.equal(consume.response, Buffer.from("<Response/>").toString("base64"));
  assert.deepEqual(
    await rpc(popup, { kind: "SAML_CONSUME", nonce, recordId }),
    { ok: false, reason: "missing" },
  );
}

test("SAML worker preserves custody and denies duplicate or forged commands", {
  timeout: 30000,
}, async () => {
  const server = serveWorker(await workerSource());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${origin}/index.html`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    await verifyCustody(page, origin);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
