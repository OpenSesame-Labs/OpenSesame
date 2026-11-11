/** Exercise every installed copy of adbkit against a loopback ADB protocol peer. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";

const ADBKIT = "@devicefarmer/adbkit";
const root = new URL("../../", import.meta.url);
const readJson = (file) =>
  JSON.parse(readFileSync(new URL(file, root), "utf8"));
const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
const edges = ["dependencies", "optionalDependencies", "peerDependencies"];

/** Every copy the lockfile installs, each required from its own directory. */
const copies = Object.keys(lock.packages)
  .filter((key) => key.endsWith(`node_modules/${ADBKIT}`))
  .map((key) => ({
    key,
    adbRequire: createRequire(new URL(`${key}/package.json`, root)),
  }));

/** One test per installed copy: none while the lockfile installs none. */
function eachCopy(title, options, run) {
  for (const { key, adbRequire } of copies)
    test(`${title} (${key})`, options, () =>
      run({ adbRequire, Adb: adbRequire("./").Adb }),
    );
}

const asciiLength = (text) =>
  Buffer.byteLength(text).toString(16).padStart(4, "0") + text;
const uint = (value) => {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
};
const syncPacket = (id, payload) =>
  Buffer.concat([Buffer.from(id), uint(payload.length), payload]);

function readFrame(buffer, sync) {
  const header = sync ? 8 : 4;
  if (buffer.length < header) return null;
  const id = sync ? buffer.toString("ascii", 0, 4) : null;
  const length = sync
    ? buffer.readUInt32LE(4)
    : Number.parseInt(buffer.toString("ascii", 0, 4), 16);
  const payloadLength = id === "DONE" ? 0 : length;
  if (buffer.length < header + payloadLength) return null;
  return {
    id,
    payload: buffer.subarray(header, header + payloadLength),
    rest: buffer.subarray(header + payloadLength),
  };
}

function syncReply(state, id, payload, send) {
  if (id === "SEND") state.destination = payload.toString();
  else if (id === "DATA") state.uploads.push(Buffer.from(payload));
  else if (id === "DONE") {
    const denied = state.destination.startsWith("/denied");
    send(
      syncPacket(
        denied ? "FAIL" : "OKAY",
        denied ? Buffer.from("permission denied") : Buffer.alloc(0),
      ),
    );
  } else if (id === "LIST") {
    if (payload.toString() === "/denied") {
      send(syncPacket("FAIL", Buffer.from("permission denied")));
      return;
    }
    send(
      Buffer.concat([
        Buffer.from("DENT"),
        uint(0o100644),
        uint(7),
        uint(123),
        uint(8),
        Buffer.from("test.xpi"),
        Buffer.from("DONE"),
        Buffer.alloc(16),
      ]),
    );
  }
}

function hostReply(state, command, send, socket) {
  if (command === "host:devices")
    send(
      `OKAY${asciiLength("online\tdevice\noffline\toffline\nlocked\tunauthorized\n")}`,
      true,
    );
  else if (command.startsWith("host:transport:")) send("OKAY");
  else if (command === "sync:") {
    state.sync = true;
    send("OKAY");
  } else if (command.startsWith("shell:am start"))
    send("OKAYError: Activity not found\n", true);
  else if (command.startsWith("shell:")) send("OKAYtransport works\n", true);
  else if (command.includes(":forward:"))
    send(`OKAYOKAY${asciiLength("43210")}`, true);
  else socket.destroy(new Error(`Unexpected command ${command}`));
}

function acceptPeer(socket, commands, uploads) {
  let buffer = Buffer.alloc(0);
  const state = { sync: false, destination: undefined, uploads };
  const send = (value, end = false) => {
    const bytes = Buffer.from(value);
    // Split the status and length fields over writes to exercise upstream parsing.
    socket.write(bytes.subarray(0, 2));
    setImmediate(() =>
      end ? socket.end(bytes.subarray(2)) : socket.write(bytes.subarray(2)),
    );
  };
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    let frame = readFrame(buffer, state.sync);
    while (frame) {
      buffer = frame.rest;
      if (state.sync) syncReply(state, frame.id, frame.payload, send);
      else {
        const command = frame.payload.toString();
        commands.push(command);
        hostReply(state, command, send, socket);
      }
      frame = readFrame(buffer, state.sync);
    }
  });
}

async function peer(Adb, run) {
  const commands = [];
  const uploads = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    acceptPeer(socket, commands, uploads);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(
      Adb.createClient({ host: "127.0.0.1", port: server.address().port }),
      commands,
      uploads,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// WXT 0.21 made web-ext an optional peer and no longer installs web-ext-run,
// so no workspace installs adbkit today. The pin and the node-forge exclusion
// stay: a runner that returns brings the pinned release, and every copy it
// installs must pass the whole suite below without node-forge.
test("adbkit is absent or the pinned release", () => {
  assert.equal(manifest.overrides[ADBKIT]["."], "3.3.8");
  assert.equal(manifest.overrides[ADBKIT]["node-forge"], "-");
  for (const { key } of copies)
    assert.equal(lock.packages[key].version, "3.3.8", key);
  if (copies.length > 0) return;
  const dependents = Object.entries(lock.packages)
    .filter(([, entry]) =>
      edges.some((field) => Object.hasOwn(entry[field] ?? {}, ADBKIT)),
    )
    .map(([key]) => key);
  assert.deepEqual(dependents, []);
  const extension = createRequire(
    new URL("apps/browser-extension/package.json", root),
  );
  const wxt = createRequire(extension.resolve("wxt"));
  for (const name of ["web-ext-run", ADBKIT])
    assert.throws(() => wxt.resolve(name), { code: "MODULE_NOT_FOUND" }, name);
});

eachCopy(
  "installed adbkit loads without the excluded crypto dependency",
  {},
  ({ adbRequire, Adb }) => {
    assert.throws(() => adbRequire.resolve("node-forge"), {
      code: "MODULE_NOT_FOUND",
    });
    assert.ok(Adb.createClient instanceof Function);
    assert.equal(Adb.createClient().bin, "adb");
    const client = Adb.createClient({
      host: "127.0.0.2",
      port: 12345,
      bin: "/configured/adb",
      timeout: 21,
    });
    assert.deepEqual(client.options, {
      host: "127.0.0.2",
      port: 12345,
      bin: "/configured/adb",
      timeout: 21,
    });
    assert.throws(() => Adb.util.parsePublicKey("unused"), /node-forge/);
    assert.throws(() => client.createTcpUsbBridge("unused"), /node-forge/);
  },
);

eachCopy(
  "fragmented host replies preserve all device states and shell readAll",
  { timeout: 5000 },
  async ({ Adb }) => {
    await peer(Adb, async (client, commands) => {
      assert.deepEqual(await client.listDevices(), [
        { id: "online", type: "device" },
        { id: "offline", type: "offline" },
        { id: "locked", type: "unauthorized" },
      ]);
      assert.equal(
        (
          await Adb.util.readAll(
            await client.getDevice("online").shell("echo transport"),
          )
        ).toString(),
        "transport works\n",
      );
      assert.ok(commands.includes("host:transport:online"));
      assert.ok(commands.includes("shell:echo transport"));
    });
  },
);

eachCopy(
  "file listing and push retain sync completion and permission errors",
  { timeout: 5000 },
  async ({ Adb }) => {
    await peer(Adb, async (client, _commands, uploads) => {
      const device = client.getDevice("online");
      const entries = await device.readdir("/extensions");
      assert.equal(entries[0].name, "test.xpi");
      assert.equal(entries[0].size, 7);
      await assert.rejects(device.readdir("/denied"), /permission denied/);
      const push = await device.push(
        Readable.from([Buffer.from("payload")]),
        "/extensions/test.xpi",
      );
      await once(push, "end");
      assert.equal(Buffer.concat(uploads).toString(), "payload");
      const denied = await device.push(
        Readable.from([Buffer.from("payload")]),
        "/denied/test.xpi",
      );
      await assert.rejects(once(denied, "end"), /permission denied/);
    });
  },
);

eachCopy(
  "activity failures remain observable for fallback and forward requests roundtrip",
  { timeout: 5000 },
  async ({ Adb }) => {
    await peer(Adb, async (client, commands) => {
      const device = client.getDevice("online");
      await assert.rejects(
        device.startActivity({ component: "org.mozilla.firefox/.App" }),
        /Activity not found/,
      );
      assert.equal(
        (
          await Adb.util.readAll(
            await device.shell("monkey -p org.mozilla.firefox 1"),
          )
        ).toString(),
        "transport works\n",
      );
      await device.forward(
        "tcp:43210",
        "localabstract:firefox-debugger-socket",
      );
      assert.ok(
        commands.some((value) =>
          value.includes(
            ":forward:tcp:43210;localabstract:firefox-debugger-socket",
          ),
        ),
      );
    });
  },
);

eachCopy(
  "connection refusal invokes the configured adb binary with its port",
  { timeout: 5000 },
  async ({ Adb }) => {
    const { mkdtemp, writeFile, readFile, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "os-adb-configured-bin-"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    try {
      const bin = join(directory, "adb");
      const record = join(directory, "args");
      await writeFile(
        bin,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); process.exit(1);\n`,
        { mode: 0o755 },
      );
      await assert.rejects(
        Adb.createClient({ host: "127.0.0.1", port, bin }).listDevices(),
      );
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), [
        "-P",
        String(port),
        "start-server",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
