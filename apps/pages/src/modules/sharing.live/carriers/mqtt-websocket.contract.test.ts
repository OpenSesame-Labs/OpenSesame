/** @vitest-environment node */
import mqttPacket, { type Packet } from "mqtt-packet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PACKET_BYTES } from "./mqtt-codec.js";
import { connectAsync } from "./mqtt-websocket.js";

type EventName = "open" | "message" | "error" | "close";
type FixtureEvent =
  | Readonly<{ data: ArrayBuffer }>
  | Readonly<{ code: number }>
  | Readonly<Record<never, never>>;
type Handler = (event: FixtureEvent) => void;
type ConnectionOptions = { username?: string; password?: string };
class FixtureSocket {
  static instances: FixtureSocket[] = [];
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<EventName, Set<Handler>>();
  readonly url: string;
  readonly protocol: string;
  binaryType = "";
  readyState = 0;
  closeCode: number | null = null;

  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    FixtureSocket.instances.push(this);
  }

  addEventListener(name: EventName, handler: Handler) {
    let listeners = this.listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(name, listeners);
    }
    listeners.add(handler);
  }

  send(value: ArrayBuffer) {
    this.sent.push(new Uint8Array(value.slice(0)));
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: Uint8Array) {
    const copy = Uint8Array.from(value);
    this.emit("message", { data: copy.buffer });
  }

  fail() {
    this.emit("error", {});
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close", { code });
  }

  private emit(name: EventName, event: FixtureEvent) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
}

function wire(packet: Parameters<typeof mqttPacket.generate>[0]): Uint8Array {
  return new Uint8Array(mqttPacket.generate(packet));
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function parsed(value: Uint8Array) {
  let packet: Packet | undefined;
  const parser = mqttPacket.parser();
  parser.on("packet", (found) => {
    packet = found;
  });
  parser.parse(Buffer.from(value));
  if (!packet)
    throw new Error("Fixture did not contain a complete MQTT packet");
  return packet;
}

function socket(at = -1): FixtureSocket {
  const found = FixtureSocket.instances.at(at);
  if (!found) throw new Error("No fixture WebSocket was opened");
  return found;
}

function accept(connection: FixtureSocket, fragments = false) {
  connection.open();
  const connack = wire({
    cmd: "connack",
    returnCode: 0,
    sessionPresent: false,
  });
  if (fragments) {
    connection.message(connack.slice(0, 1));
    connection.message(connack.slice(1));
  } else connection.message(connack);
}

async function connected(options?: ConnectionOptions) {
  const pending = connectAsync("wss://broker.example.test/mqtt", {
    reconnectPeriod: 0,
    connectTimeout: 8000,
    clean: true,
    timerVariant: "native",
    ...options,
  });
  const connection = socket();
  accept(connection, true);
  return { client: await pending, connection };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FixtureSocket.instances = [];
});

describe("the product MQTT WebSocket contract", () => {
  it("authenticates, subscribes, receives coalesced/fragmented QoS 1, and publishes with acknowledgements", async () => {
    vi.stubGlobal("WebSocket", FixtureSocket);
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const { client, connection } = await connected({
      username: "route-user",
      password: "route-password",
    });
    const connect = parsed(connection.sent[0]);
    if (connect.cmd !== "connect") throw new Error("Expected CONNECT");
    expect(connect).toMatchObject({
      cmd: "connect",
      protocolVersion: 4,
      clean: true,
      username: "route-user",
    });
    expect(Buffer.from(connect.password ?? []).toString()).toBe(
      "route-password",
    );
    expect(connection.protocol).toBe("mqtt");
    expect(connection.binaryType).toBe("arraybuffer");

    const messages: [string, Uint8Array][] = [];
    client.on("message", (topic, payload) => messages.push([topic, payload]));
    const subscribed = client.subscribeAsync("opensesame/live/topic", {
      qos: 1,
    });
    await Promise.resolve();
    const subscribe = parsed(connection.sent.at(-1) ?? new Uint8Array());
    expect(subscribe).toMatchObject({
      cmd: "subscribe",
      subscriptions: [{ topic: "opensesame/live/topic", qos: 1 }],
    });
    const incoming = wire({
      cmd: "publish",
      topic: "opensesame/live/topic",
      payload: Buffer.from([0, 1, 2, 255]),
      qos: 1,
      messageId: 77,
      dup: true,
      retain: true,
    });
    connection.message(
      concatenate(
        wire({ cmd: "suback", messageId: subscribe.messageId, granted: [1] }),
        incoming.slice(0, 3),
      ),
    );
    connection.message(incoming.slice(3));
    await expect(subscribed).resolves.toEqual([1]);
    expect(messages).toEqual([
      ["opensesame/live/topic", Uint8Array.of(0, 1, 2, 255)],
    ]);
    expect(parsed(connection.sent.at(-1) ?? new Uint8Array())).toMatchObject({
      cmd: "puback",
      messageId: 77,
    });

    const published = client.publishAsync(
      "opensesame/live/topic",
      "sealed frame",
      { qos: 1, retain: false },
    );
    await Promise.resolve();
    const publish = parsed(connection.sent.at(-1) ?? new Uint8Array());
    expect(publish).toMatchObject({
      cmd: "publish",
      topic: "opensesame/live/topic",
      qos: 1,
      retain: false,
      dup: false,
    });
    connection.message(wire({ cmd: "puback", messageId: publish.messageId }));
    await expect(published).resolves.toBeUndefined();
    expect(logs.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    await client.endAsync(true);
    expect(parsed(connection.sent.at(-1) ?? new Uint8Array())).toMatchObject({
      cmd: "disconnect",
    });
  });

  it("reconnects, resubscribes, and retransmits an unacknowledged publish with DUP", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FixtureSocket);
    const { client, connection } = await connected();
    const subscribed = client.subscribeAsync("opensesame/live/reconnect", {
      qos: 1,
    });
    await Promise.resolve();
    const subscribe = parsed(connection.sent.at(-1) ?? new Uint8Array());
    connection.message(
      wire({ cmd: "suback", messageId: subscribe.messageId, granted: [1] }),
    );
    await subscribed;
    const pendingSubscription = client.subscribeAsync(
      "opensesame/live/pending-subscribe",
      { qos: 1 },
    );
    await Promise.resolve();
    const firstPendingSubscribe = parsed(
      connection.sent.at(-1) ?? new Uint8Array(),
    );
    if (firstPendingSubscribe.cmd !== "subscribe")
      throw new Error("Expected pending SUBSCRIBE");
    client.options.reconnectPeriod = 3000;
    const publishing = client.publishAsync(
      "opensesame/live/reconnect",
      "pending frame",
      { qos: 1, retain: false },
    );
    await Promise.resolve();
    const firstPublish = parsed(connection.sent.at(-1) ?? new Uint8Array());
    connection.close(1006);
    await vi.advanceTimersByTimeAsync(3000);
    const replacement = socket();
    accept(replacement);
    await vi.advanceTimersByTimeAsync(0);
    const packets = replacement.sent.map(parsed);
    const subscriptions = packets.filter(
      (packet) => packet.cmd === "subscribe",
    );
    expect(subscriptions).toHaveLength(2);
    expect(
      subscriptions.some(
        (packet) => packet.messageId === firstPendingSubscribe.messageId,
      ),
    ).toBe(true);
    const retransmit = packets.find((packet) => packet.cmd === "publish");
    expect(retransmit).toMatchObject({
      cmd: "publish",
      messageId: firstPublish.messageId,
      dup: true,
    });
    replacement.message(
      wire({ cmd: "puback", messageId: firstPublish.messageId }),
    );
    replacement.message(
      wire({
        cmd: "suback",
        messageId: firstPendingSubscribe.messageId,
        granted: [1],
      }),
    );
    await expect(publishing).resolves.toBeUndefined();
    await expect(pendingSubscription).resolves.toEqual([1]);
    await client.endAsync(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(FixtureSocket.instances).toHaveLength(2);
  });

  it("pings, accepts PINGRESP, and closes a silent broker on the next interval", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FixtureSocket);
    const { client, connection } = await connected();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(parsed(connection.sent.at(-1) ?? new Uint8Array())).toMatchObject({
      cmd: "pingreq",
    });
    connection.message(wire({ cmd: "pingresp" }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(parsed(connection.sent.at(-1) ?? new Uint8Array())).toMatchObject({
      cmd: "pingreq",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connection.readyState).toBe(3);
    await client.endAsync(true);
  });

  it("rejects refused connections and subscriptions", async () => {
    vi.stubGlobal("WebSocket", FixtureSocket);
    const opening = connectAsync("wss://broker.example.test", {
      reconnectPeriod: 0,
      clean: true,
    });
    const refused = socket();
    refused.open();
    refused.message(
      wire({ cmd: "connack", returnCode: 5, sessionPresent: false }),
    );
    await expect(opening).rejects.toThrow("CONNACK refused");

    FixtureSocket.instances = [];
    const { client, connection } = await connected();
    const subscribed = client.subscribeAsync("opensesame/live/refused", {
      qos: 1,
    });
    await Promise.resolve();
    const subscribe = parsed(connection.sent.at(-1) ?? new Uint8Array());
    connection.message(
      wire({ cmd: "suback", messageId: subscribe.messageId, granted: [0x80] }),
    );
    await expect(subscribed).rejects.toThrow("subscription was refused");
    await client.endAsync(true);
  });

  it("bounds outbound, buffered, malformed, and unsupported broker packets", async () => {
    vi.stubGlobal("WebSocket", FixtureSocket);
    const cases: Uint8Array[] = [
      new Uint8Array(MAX_PACKET_BYTES + 1),
      Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01),
      Uint8Array.of(0x40, 1, 0),
      Uint8Array.of(0xd0, 1, 0),
      Uint8Array.of(0x30, 3, 0, 1, 0xff),
      wire({
        cmd: "publish",
        topic: "opensesame/live/topic",
        payload: "hostile",
        qos: 2,
        messageId: 9,
        dup: false,
        retain: false,
      }),
    ];
    for (const hostile of cases) {
      FixtureSocket.instances = [];
      const { client, connection } = await connected();
      connection.message(hostile);
      expect(connection.closeCode).toBe(1002);
      await client.endAsync(true);
    }

    FixtureSocket.instances = [];
    const { client } = await connected();
    await expect(
      client.publishAsync(
        "opensesame/live/topic",
        "x".repeat(MAX_PACKET_BYTES),
        {
          qos: 1,
          retain: false,
        },
      ),
    ).rejects.toThrow("publish is too large");
    await client.endAsync(true);
  });

  it("bounds the number of unacknowledged packets", async () => {
    vi.stubGlobal("WebSocket", FixtureSocket);
    const { client } = await connected();
    const pending = Array.from({ length: 512 }, (_, index) =>
      client.publishAsync("opensesame/live/topic", `sealed frame ${index}`, {
        qos: 1,
        retain: false,
      }),
    );
    for (const operation of pending) void operation.catch(() => {});
    await Promise.all(Array.from({ length: 4 }, () => Promise.resolve()));
    await expect(
      client.publishAsync("opensesame/live/topic", "one too many", {
        qos: 1,
        retain: false,
      }),
    ).rejects.toThrow("too many in-flight");
    await client.endAsync(true);
    expect(
      (await Promise.allSettled(pending)).every(
        (row) => row.status === "rejected",
      ),
    ).toBe(true);
  });
});
