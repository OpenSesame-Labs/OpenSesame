/** @vitest-environment node */
import mqttPacket, { type Packet } from "mqtt-packet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAsync } from "./mqtt-websocket.js";

type EventName = "open" | "message" | "error" | "close";
type FixtureEvent =
  | Readonly<{ data: ArrayBuffer }>
  | Readonly<{ code: number }>
  | Readonly<Record<never, never>>;
type Handler = (event: FixtureEvent) => void;

class LifecycleSocket {
  static instances: LifecycleSocket[] = [];
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<EventName, Set<Handler>>();
  binaryType = "";
  readyState = 0;
  closeCode: number | null = null;

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    LifecycleSocket.instances.push(this);
  }

  addEventListener(name: EventName, handler: Handler) {
    const listeners = this.listeners.get(name) ?? new Set<Handler>();
    listeners.add(handler);
    this.listeners.set(name, listeners);
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

function parsed(value: Uint8Array): Packet {
  let packet: Packet | undefined;
  const parser = mqttPacket.parser();
  parser.on("packet", (found) => {
    packet = found;
  });
  parser.parse(Buffer.from(value));
  if (!packet) throw new Error("Fixture did not contain a complete packet");
  return packet;
}

function socket(at = -1): LifecycleSocket {
  const found = LifecycleSocket.instances.at(at);
  if (!found) throw new Error("No fixture WebSocket was opened");
  return found;
}

function accept(connection: LifecycleSocket) {
  connection.open();
  connection.message(
    wire({ cmd: "connack", returnCode: 0, sessionPresent: false }),
  );
}

async function connected() {
  const pending = connectAsync("wss://broker.example.test/mqtt", {
    reconnectPeriod: 100,
    connectTimeout: 1000,
    clean: true,
    timerVariant: "native",
  });
  const connection = socket();
  accept(connection);
  return { client: await pending, connection };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  LifecycleSocket.instances = [];
});

describe("the MQTT WebSocket connection lifecycle", () => {
  it("does not combine a partial packet with the replacement stream", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", LifecycleSocket);
    const { client, connection } = await connected();
    const incoming = wire({
      cmd: "publish",
      topic: "opensesame/live/topic",
      payload: "partial",
      qos: 1,
      messageId: 7,
      dup: false,
      retain: false,
    });
    connection.message(incoming.slice(0, 3));
    connection.close(1006);
    await vi.advanceTimersByTimeAsync(100);
    const replacement = socket();
    accept(replacement);
    await vi.advanceTimersByTimeAsync(0);

    const publishing = client.publishAsync(
      "opensesame/live/topic",
      "new stream",
      { qos: 1, retain: false },
    );
    await Promise.resolve();
    const publish = parsed(replacement.sent.at(-1) ?? new Uint8Array());
    if (publish.cmd !== "publish") throw new Error("Expected PUBLISH");
    replacement.message(wire({ cmd: "puback", messageId: publish.messageId }));
    await expect(publishing).resolves.toBeUndefined();
    await client.endAsync(true);
  });

  it("rejects operations waiting for reconnect when the client closes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", LifecycleSocket);
    const { client, connection } = await connected();
    connection.close(1006);
    const publishing = client.publishAsync("opensesame/live/topic", "queued", {
      qos: 1,
      retain: false,
    });
    const subscribing = client.subscribeAsync("opensesame/live/topic", {
      qos: 1,
    });
    await client.endAsync(true);
    await expect(publishing).rejects.toThrow("MQTT client is closed");
    await expect(subscribing).rejects.toThrow("MQTT client is closed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(LifecycleSocket.instances).toHaveLength(1);
  });
});
