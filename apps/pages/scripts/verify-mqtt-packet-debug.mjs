/** Real-broker regression for the MQTT credential and frame log boundary. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Aedes } from "aedes";
import { chromium } from "playwright";
import { build, createServer as createViteServer } from "vite";
import { WebSocketServer, createWebSocketStream } from "ws";
import { mqttPacketDebugGuard } from "./mqtt-packet-debug-plugin.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const pages = fileURLToPath(new URL("..", import.meta.url));
const carrier = fileURLToPath(
  new URL("../src/modules/sharing.live/carriers/mqtt.ts", import.meta.url),
);

async function compile(guarded) {
  const result = await build({
    root: pages,
    configFile: false,
    logLevel: "error",
    plugins: guarded ? [mqttPacketDebugGuard(root)] : [],
    build: {
      write: false,
      lib: { entry: carrier, formats: ["es"] },
      target: "es2022",
      minify: "terser",
    },
  });
  const first = Array.isArray(result) ? result[0] : result;
  const chunk = first.output.find((entry) => entry.type === "chunk");
  assert.ok(chunk, "the MQTT carrier built");
  return chunk.code;
}

async function capture(page, origin, moduleUrl, shouldLeak) {
  await page.addInitScript(() => {
    localStorage.setItem("debug", "*");
    window.__mqttLogs = [];
    for (const name of ["log", "debug", "warn", "info", "error"]) {
      const original = console[name];
      console[name] = (...args) => {
        for (const arg of args) {
          const seen = new WeakSet();
          const text = JSON.stringify(arg, (_key, value) => {
            if (ArrayBuffer.isView(value)) {
              return new TextDecoder().decode(value);
            }
            if (value?.type === "Buffer" && Array.isArray(value.data)) {
              return new TextDecoder().decode(new Uint8Array(value.data));
            }
            if (Object(value) === value) {
              if (seen.has(value)) return "[circular]";
              seen.add(value);
            }
            return value;
          });
          window.__mqttLogs.push(text ?? "");
        }
        original.apply(console, args);
      };
    }
  });
  await page.goto(origin);
  const received = await page.evaluate(
    async ({ moduleUrl, origin }) => {
      const module = await import(moduleUrl);
      let mqttCarrier = module.mqttCarrier;
      if (!mqttCarrier) {
        // The application build exposes its lazily initialized module under
        // Rolldown's generated export names. Find the initializer and namespace
        // by shape, rather than assuming those names remain stable.
        const values = Object.values(module);
        const initializers = values.filter(
          (value) => value instanceof Function,
        );
        const namespaces = values.filter(
          (value) => value?.mqttCarrier instanceof Function,
        );
        if (initializers.length !== 1 || namespaces.length !== 1)
          throw new Error("could not initialize the built MQTT carrier");
        initializers[0]();
        mqttCarrier = namespaces[0].mqttCarrier;
      }
      const endpoint = new URL("/mqtt", origin);
      endpoint.protocol = "ws:";
      const connection = await mqttCarrier(
        {
          kind: "mqtt",
          url: endpoint.href,
          username: "synthetic-user-only",
          password: "synthetic-secret-only",
        },
        "test",
      );
      try {
        let receive;
        const delivery = new Promise((resolve) => {
          receive = resolve;
        });
        connection.listen((value) => receive(value));
        await connection.post("synthetic-frame-only");
        return await Promise.race([
          delivery,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MQTT echo timed out")), 5000),
          ),
        ]);
      } finally {
        connection.close();
      }
    },
    { moduleUrl, origin },
  );
  assert.equal(received, "synthetic-frame-only");
  const log = (await page.evaluate(() => window.__mqttLogs)).join("\n");
  assert.equal(log.includes("synthetic-secret-only"), shouldLeak);
  assert.equal(log.includes("synthetic-user-only"), shouldLeak);
  assert.equal(log.includes("synthetic-frame-only"), shouldLeak);
}

test("MQTT debug logging cannot expose credentials or frames", {
  timeout: 90000,
}, async () => {
  let protectedBundle = "";
  let baselineBundle = "";
  let authentications = 0;
  const dist = process.env.PAGES_MQTT_TEST_DIST
    ? resolve(root, process.env.PAGES_MQTT_TEST_DIST)
    : null;
  const fullChunks = dist
    ? readdirSync(join(dist, "assets")).filter((name) =>
        /^live-mqtt-.*\.js$/.test(name),
      )
    : [];
  if (dist) assert.equal(fullChunks.length, 1, "the app emits one MQTT chunk");
  const server = createHttpServer((request, response) => {
    const bundle =
      request.url === "/protected.js" ? protectedBundle : baselineBundle;
    const asset = /^\/assets\/([a-zA-Z0-9_.-]+)$/.exec(request.url ?? "")?.[1];
    if (asset && dist) {
      try {
        const contents = readFileSync(join(dist, "assets", asset));
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(contents);
      } catch {
        response.writeHead(404);
        response.end();
      }
    } else if (
      request.url === "/protected.js" ||
      request.url === "/baseline.js"
    ) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundle);
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>MQTT test</title>");
    }
  });
  const broker = await Aedes.createBroker({
    authenticate(_client, user, password, done) {
      const valid =
        user === "synthetic-user-only" &&
        password.toString() === "synthetic-secret-only";
      if (valid) authentications += 1;
      done(null, valid);
    },
  });
  let sockets;
  let browser;
  let dev;
  try {
    sockets = new WebSocketServer({
      server,
      path: "/mqtt",
      handleProtocols: (protocols) => (protocols.has("mqtt") ? "mqtt" : false),
    });
    sockets.on("connection", (socket) =>
      broker.handle(createWebSocketStream(socket)),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    protectedBundle = await compile(true);
    baselineBundle = await compile(false);
    dev = await createViteServer({
      root: pages,
      configFile: false,
      logLevel: "error",
      plugins: [mqttPacketDebugGuard(root)],
      server: { host: "127.0.0.1", port: 0, cors: true },
    });
    await dev.listen();
    const devUrl = `http://127.0.0.1:${dev.httpServer.address().port}/src/modules/sharing.live/carriers/mqtt.ts`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const scenarios = [
      ["/baseline.js", true],
      ["/protected.js", false],
      [devUrl, false],
    ];
    if (dist) scenarios.push([`/assets/${fullChunks[0]}`, false]);
    for (const [url, shouldLeak] of scenarios) {
      const context = await browser.newContext();
      try {
        await capture(await context.newPage(), origin, url, shouldLeak);
      } finally {
        await context.close();
      }
    }
    assert.equal(authentications, scenarios.length);
  } finally {
    await browser?.close();
    await dev?.close();
    if (sockets) await new Promise((resolve) => sockets.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await broker.close();
  }
});
