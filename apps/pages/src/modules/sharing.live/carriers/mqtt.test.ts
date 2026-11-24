/** @vitest-environment node */

import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Connect, mqttCarrier } from "./mqtt.js";

describe("mqtt", () => {
  /**
   * The MQTT carrier's client options: no retry of a first connection,
   * reconnecting only once a broker has answered, and the page's own timers
   * rather than a worker from a Blob URL; a failed subscription closes
   * the client rather than leaking it. The connector is injected — the real
   * client against a broker that hangs up is the "reconnect" suite below.
   */

  type Options = {
    reconnectPeriod?: number;
    username?: string;
    timerVariant?: string;
    log?: (...values: string[]) => void;
  };
  type Call = {
    url: string;
    options: Options;
    allowRetries: boolean | undefined;
  };

  /** A client that connects, and whose subscription answers as told. */
  function broker(subscribe: () => Promise<string[]>) {
    const client = {
      options: { reconnectPeriod: 0 },
      subscribeAsync: vi.fn(subscribe),
      publishAsync: vi.fn(async () => {}),
      endAsync: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    };
    const calls: Call[] = [];
    const connect: Connect = overlapCast(
      async (url: string, options: Options, allowRetries?: boolean) => {
        calls.push({ url, options: { ...options }, allowRetries });
        return client;
      },
    );
    return { client, calls, connect };
  }

  describe("mqttCarrier", () => {
    it("asks for a rejection on failure, holds reconnecting until connected, then allows it", async () => {
      const { client, calls, connect } = broker(async () => []);
      const carrier = await mqttCarrier(
        { kind: "mqtt", url: "wss://broker.example.test", username: "u" },
        "topic",
        connect,
      );
      expect(calls).toEqual([
        {
          url: "wss://broker.example.test",
          // Nothing reconnects while the first connection is in flight, and
          // the timers are the page's: no Blob-URL worker for WebKit to lose.
          options: expect.objectContaining({
            reconnectPeriod: 0,
            username: "u",
            timerVariant: "native",
          }),
          allowRetries: false,
        },
      ]);
      expect(client.options.reconnectPeriod).toBe(3000);
      expect(calls[0].options.log).toEqual(expect.any(Function));
      const debug = vi.spyOn(console, "debug");
      calls[0].options.log?.("synthetic-secret-only");
      expect(debug).not.toHaveBeenCalled();
      debug.mockRestore();
      expect(client.subscribeAsync).toHaveBeenCalledWith(
        "opensesame/live/topic",
        {
          qos: 1,
        },
      );
      carrier.close();
      expect(client.endAsync).toHaveBeenCalledWith(true);
    });

    it("ends a client whose subscription fails, and passes the failure on", async () => {
      const { client, connect } = broker(async () => {
        throw new Error("not authorized");
      });
      await expect(
        mqttCarrier(
          { kind: "mqtt", url: "wss://broker.example.test" },
          "t",
          connect,
        ),
      ).rejects.toThrow("not authorized");
      expect(client.endAsync).toHaveBeenCalledWith(true);
      expect(client.options.reconnectPeriod).toBe(0);
    });
  });
});

describe("reconnect", () => {
  /**
   * An MQTT broker that cannot be used is knocked on once, not for as long as
   * the tab lives. The real client (mqtt.js) against a server that completes
   * the WebSocket handshake and then drops the connection with no CONNACK — the
   * shape of a browser's failed socket, which reports a close and no error:
   * the promise rejects, and the connection count stops. `connectAsync`'s
   * default retries every few seconds, forever, with nothing that leaving,
   * ending or locking could reach.
   */

  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = null;
  });

  /** Upgrades, then hangs up: opens, never answers CONNECT. */
  async function unwelcoming() {
    let upgrades = 0;
    const listening = createServer();
    listening.on("upgrade", (request, socket) => {
      upgrades += 1;
      const key = String(request.headers["sec-websocket-key"]);
      const accept = createHash("sha1")
        .update(key + GUID)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "Sec-WebSocket-Protocol: mqtt",
          "",
          "",
        ].join("\r\n"),
      );
      setTimeout(() => socket.destroy(), 20);
    });
    server = listening;
    await new Promise<void>((resolve) =>
      listening.listen(0, "127.0.0.1", () => resolve()),
    );
    // A TCP server (not a pipe) reports its address as an AddressInfo.
    const address: AddressInfo = overlapCast(listening.address());
    const { port } = address;
    return { port, count: () => upgrades };
  }

  describe("an MQTT broker that cannot be used", () => {
    it("rejects, and stops knocking", async () => {
      // mqtt.js schedules its retries with `setInterval`: that clock is the
      // test's, the sockets and every other timer stay real.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const { port, count } = await unwelcoming();
        await expect(
          mqttCarrier({ kind: "mqtt", url: `ws://127.0.0.1:${port}` }, "topic"),
        ).rejects.toThrow();
        const knocks = count();
        expect(knocks).toBeGreaterThanOrEqual(1);
        // Past two of the old 3 s reconnect periods: a retry would fire here
        // and open a real socket, which the server counts.
        await vi.advanceTimersByTimeAsync(6500);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(count()).toBe(knocks);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
