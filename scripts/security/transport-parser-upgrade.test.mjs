import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, get } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const fromRedteam = createRequire(resolve("tests/redteam/package.json"));
const fromPromptfoo = createRequire(fromRedteam.resolve("promptfoo"));
const fromProxy = createRequire(fromPromptfoo.resolve("proxy-agent"));
const fromPacProxy = createRequire(fromProxy.resolve("pac-proxy-agent"));
const fromGetUri = createRequire(fromPacProxy.resolve("get-uri"));
const fromStorage = createRequire(fromPromptfoo.resolve("@azure/storage-blob"));
const fromXml = createRequire(fromStorage.resolve("@azure/core-xml"));
const { parseList } = fromGetUri("basic-ftp/dist/parseList.js");
const { XMLParser, XMLBuilder } = fromPromptfoo("fast-xml-parser");
const { parseXML, stringifyXML } = fromXml("@azure/core-xml");

function child(script, timeout = 5000) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout,
  });
}

test("FTP MLSD listing safely ignores inherited-property fact names", () => {
  for (const name of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    const items = parseList(`${name}=x;type=file;size=10; evil.txt`);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "evil.txt");
    assert.equal(items[0].size, 10);
  }
  const items = parseList("type=file;size=3;modify=20260101010101; good.txt");
  assert.equal(items[0].name, "good.txt");
  assert.equal(items[0].size, 3);
});

test("FTP login rejects control characters without an uncaught process exception", () => {
  const result = child(String.raw`
    import { createServer } from 'node:net';
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const { Client } = createRequire(import.meta.url)(${JSON.stringify(fromGetUri.resolve("basic-ftp"))});
    const server=createServer(socket=>{
      socket.write('220 ready\r\n');
      socket.on('data',data=>{if(String(data).startsWith('USER'))socket.write('331 password\r\n');else socket.write('200 ok\r\n');});
    });
    server.listen(0,'127.0.0.1',async()=>{
      const c=new Client(2000);let rejected=false;
      try { await c.access({host:'127.0.0.1',port:server.address().port,user:'test',password:'synthetic\r\ninvalid'}); }
      catch (error) {rejected=/Invalid command: Contains control characters/.test(error.message) && !error.message.includes('synthetic');} finally {c.close();server.close();}
      assert.equal(rejected,true);console.log('rejected safely');
    });
  `);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rejected safely/);
});

test("upgraded get-uri FTP transport fetches a real local stream", async () => {
  const { getUri } = await import(
    pathToFileURL(fromPacProxy.resolve("get-uri")).href
  );
  const servers = [];
  const server = createServer((socket) => {
    socket.write("220 ready\r\n");
    let pending = "";
    let transfer;
    socket.on("data", (data) => {
      pending += data.toString();
      let pos = pending.indexOf("\r\n");
      while (pos >= 0) {
        const line = pending.slice(0, pos);
        pending = pending.slice(pos + 2);
        const cmd = line.split(" ")[0];
        if (cmd === "USER") socket.write("331 password\r\n");
        else if (cmd === "PASS") socket.write("230 logged in\r\n");
        else if (cmd === "FEAT")
          socket.write("211-Features\r\n MDTM\r\n EPSV\r\n211 End\r\n");
        else if (cmd === "MDTM") socket.write("213 20260101000000\r\n");
        else if (cmd === "EPSV") {
          const dataServer = createServer((connection) => {
            transfer = connection;
          });
          servers.push(dataServer);
          dataServer.listen(0, "127.0.0.1", () =>
            socket.write(
              `229 Entering Extended Passive Mode (|||${dataServer.address().port}|)\r\n`,
            ),
          );
        } else if (cmd === "RETR") {
          socket.write("150 data follows\r\n");
          transfer.end("known ftp payload", () => {
            socket.write("226 transfer complete\r\n");
            servers.at(-1).close();
          });
        } else if (cmd === "QUIT") {
          socket.end("221 goodbye\r\n");
        } else socket.write("200 OK\r\n");
        pos = pending.indexOf("\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const stream = await getUri(
      `ftp://test:pw@127.0.0.1:${server.address().port}/a.txt`,
    );
    let text = "";
    for await (const chunk of stream) text += chunk;
    assert.equal(text, "known ftp payload");
  } finally {
    for (const item of servers) item.close();
    server.close();
  }
});

test("upgraded proxy chain executes a PAC file and sends traffic through its selected proxy", async () => {
  const { ProxyAgent } = await import(
    pathToFileURL(fromPromptfoo.resolve("proxy-agent")).href
  );
  const requests = [];
  const server = createHttpServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/proxy.pac") {
      response.setHeader("content-type", "application/x-ns-proxy-autoconfig");
      response.end(`function FindProxyForURL(url, host) {
        if (shExpMatch(host, "*.invalid") && dnsDomainIs(host, ".invalid"))
          return "PROXY 127.0.0.1:${server.address().port}";
        return "DIRECT";
      }`);
    } else response.end("proxy response");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new ProxyAgent({
    getProxyForUrl: () =>
      `pac+http://127.0.0.1:${server.address().port}/proxy.pac`,
  });
  try {
    const response = await new Promise((resolve, reject) => {
      get("http://target.invalid/resource", { agent }, resolve).on(
        "error",
        reject,
      );
    });
    let result = "";
    for await (const chunk of response) result += chunk;
    assert.equal(result, "proxy response");
    assert.deepEqual(requests, [
      "/proxy.pac",
      "http://target.invalid/resource",
    ]);
  } finally {
    agent.destroy();
    server.close();
  }
});

test("XML parsing retains ordinary, stop-node and Azure core-xml behavior", async () => {
  const parser = new XMLParser({
    stopNodes: ["root.payload"],
    ignoreAttributes: false,
  });
  assert.deepEqual(
    parser.parse('<root a="x"><payload><b>kept</b></payload><n>7</n></root>'),
    { root: { payload: "<b>kept</b>", n: 7, "@_a": "x" } },
  );
  const xml = new XMLBuilder({ ignoreAttributes: false }).build({
    root: { "@_a": "x", n: 7 },
  });
  assert.deepEqual(new XMLParser({ ignoreAttributes: false }).parse(xml), {
    root: { n: 7, "@_a": "x" },
  });
  const azure = stringifyXML({ Root: { Value: "hello" } });
  assert.ok(azure.includes("hello"));
  assert.ok(JSON.stringify(await parseXML(azure)).includes("hello"));
});

test("unterminated XML stop nodes fail within a bounded child process", () => {
  const result = child(
    `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const { XMLParser } = createRequire(import.meta.url)(${JSON.stringify(fromPromptfoo.resolve("fast-xml-parser"))});
    const parser=new XMLParser({stopNodes:['stop']});
    assert.throws(()=>parser.parse('<stop>'+'<a '.repeat(50000)), /Unexpected end/);
    console.log('bounded');
  `,
    2000,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bounded/);
});
