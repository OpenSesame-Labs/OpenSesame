import { Readable } from "node:stream";
import vm from "node:vm";
import {
  type JsonObject,
  isFunction,
  isJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VERCEL_RELAY_FETCH_SOURCE } from "./vercel-relay-function.js";

/** The jar the relay hands back: origin, then cookie name, then value. */
const jarSchema = z.record(z.string(), z.record(z.string(), z.string()));

interface MockRes {
  statusCode: number;
  body: string | JsonObject;
  json(): JsonObject;
}

/** The response half of the Node pair Vercel hands a function. */
interface RelayResponder {
  status(code: number): RelayResponder;
  send(text: string): RelayResponder;
  json(data: JsonObject): RelayResponder;
}

type RelayHandler = (req: Readable, res: RelayResponder) => Promise<void>;

/** CommonJS `module`: empty exports until the relay source assigns its handler. */
interface RelayModule {
  exports: RelayHandler | Record<string, never>;
}

function loadFetchHandler(
  fetchImpl: typeof fetch,
): (body: JsonObject) => Promise<MockRes> {
  const module: RelayModule = { exports: {} };
  const sandbox: vm.Context = {
    module,
    exports: module.exports,
    process: { env: { RELAY_TOKEN: "relay-token" } },
    fetch: fetchImpl,
    Headers,
    URL,
    TextDecoder,
    TextEncoder,
    Buffer,
    Map,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(VERCEL_RELAY_FETCH_SOURCE, sandbox);
  const handler = module.exports;
  if (!isFunction(handler)) throw new Error("relay source exported no handler");
  return async (rpc) => {
    const body = Buffer.from(JSON.stringify(rpc));
    let sent = false;
    const req = new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(body);
        this.push(null);
      },
    });
    Object.assign(req, {
      method: "POST",
      headers: { authorization: "Bearer relay-token" },
    });
    let statusCode = 200;
    let payload: string | JsonObject = "";
    const res: RelayResponder = {
      status(code) {
        statusCode = code;
        return this;
      },
      send(text) {
        payload = text;
        return this;
      },
      json(data) {
        payload = data;
        return this;
      },
    };
    await handler(req, res);
    return {
      statusCode,
      body: payload,
      json() {
        if (!isJsonObject(payload)) throw new Error("expected json body");
        return payload;
      },
    };
  };
}

describe("vercel relay fetch handler source", () => {
  it("returns an updated jar for the client to carry across instances", async () => {
    const invoke = loadFetchHandler(async () =>
      Response.json(
        { ok: true },
        {
          headers: {
            "set-cookie": "session=abc; Path=/; Secure",
          },
        },
      ),
    );
    const result = await invoke({
      sessionId: "s1",
      url: "https://accounts.example.test/reset",
      method: "GET",
      allowedOrigins: ["https://accounts.example.test"],
      jar: {},
    });
    expect(result.statusCode).toBe(200);
    const jar = jarSchema.parse(result.json().jar);
    expect(jar["https://accounts.example.test"]?.session).toBe("abc");
  });

  it("converts POST to GET on 302 redirects", async () => {
    const seen: { method: string; url: string }[] = [];
    const invoke = loadFetchHandler(async (input, init) => {
      seen.push({ method: init?.method ?? "GET", url: String(input) });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://rp.test/done" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const result = await invoke({
      sessionId: "s2",
      url: "https://rp.test/reset",
      method: "POST",
      body: "password=secret",
      allowedOrigins: ["https://rp.test"],
      jar: {},
    });
    expect(result.statusCode).toBe(200);
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.url).toBe("https://rp.test/done");
  });

  it("drops non-string and prototype-polluting jar entries", async () => {
    let sentCookies = "";
    const invoke = loadFetchHandler(async (_input, init) => {
      sentCookies = new Headers(init?.headers).get("cookie") ?? "";
      return new Response("ok", { status: 200 });
    });
    const result = await invoke({
      sessionId: "s4",
      url: "https://rp.test/reset",
      method: "GET",
      allowedOrigins: ["https://rp.test"],
      jar: {
        "https://rp.test": {
          good: "yes",
          nested: { polluted: true },
          count: 7,
          ["__proto__"]: "polluted",
        },
        "https://other.test": "not-a-record",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(sentCookies).toBe("good=yes");
    const jar = jarSchema.parse(result.json().jar);
    expect(jar["https://rp.test"]).toEqual({ good: "yes" });
    expect(jar["https://other.test"]).toBeUndefined();
    expect("polluted" in Object.prototype).toBe(false);
  });

  it("caps upstream bodies while streaming", async () => {
    const huge = "x".repeat(2_000_000);
    const invoke = loadFetchHandler(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const result = await invoke({
      sessionId: "s3",
      url: "https://rp.test/large",
      method: "GET",
      allowedOrigins: ["https://rp.test"],
      jar: {},
    });
    const bodyText = z.string().parse(result.json().bodyText);
    expect(bodyText.length).toBe(1_048_576);
  });
});
