import {
  KEEPALIVE_SECONDS,
  MAX_PACKET_BYTES,
  MAX_REMAINING_LENGTH,
  concatenate,
  connectPacket,
  decodeText,
  mqttPacket,
  publishPacket,
  subscribePacket,
  twoByte,
} from "./mqtt-codec.js";

type Listener = (topic: string, payload: Uint8Array) => void;
const MAX_IN_FLIGHT = 512;

export type MqttBrowserOptions = {
  username?: string;
  password?: string;
  clean?: boolean;
  reconnectPeriod: number;
  connectTimeout?: number;
  timerVariant?: "native";
};

export type MqttBrowserClient = {
  options: MqttBrowserOptions;
  subscribeAsync(topic: string, options: { qos: 1 }): Promise<number[]>;
  publishAsync(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
  ): Promise<void>;
  endAsync(force: true): Promise<void>;
  on(event: "message", listener: Listener): void;
  off(event: "message", listener: Listener): void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function send(socket: WebSocket | null, bytes: Uint8Array) {
  if (socket === null) return;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  socket.send(copy.buffer);
}

type Pending = {
  kind: "publish" | "subscribe";
  packet: Uint8Array;
  resolve: (value: never) => void;
  reject: (reason?: unknown) => void;
};

class BrowserMqttClient implements MqttBrowserClient {
  readonly options: MqttBrowserOptions;
  readonly #url: string;
  readonly #clientId = `opensesame_${[
    ...crypto.getRandomValues(new Uint8Array(16)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
  readonly #listeners = new Set<Listener>();
  readonly #subscriptions = new Set<string>();
  readonly #pending = new Map<number, Pending>();
  #socket: WebSocket | null = null;
  #buffer = new Uint8Array();
  #packetId = 0;
  #connected = false;
  #everConnected = false;
  #ending = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  #waitingForPing = false;
  #ready = deferred<void>();

  constructor(url: string, options: MqttBrowserOptions) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      throw new Error("MQTT browser carriers require a ws:// or wss:// URL");
    this.#url = parsed.href;
    this.options = options;
  }

  async start(): Promise<void> {
    await this.#open();
  }

  async #open(resolveReady = true): Promise<void> {
    if (this.#ending) throw new Error("MQTT client is closed");
    const opened = deferred<void>();
    const socket = new WebSocket(this.#url, "mqtt");
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    let accepted = false;
    const timeout = setTimeout(() => {
      if (!accepted) socket.close();
    }, this.options.connectTimeout ?? 30_000);
    socket.addEventListener("open", () => {
      send(socket, connectPacket(this.#clientId, this.options));
    });
    socket.addEventListener("message", (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer))
          throw new Error("MQTT broker sent a non-binary WebSocket message");
        if (event.data.byteLength > MAX_PACKET_BYTES)
          throw new Error("MQTT WebSocket message is too large");
        this.#receive(new Uint8Array(event.data), () => {
          if (accepted) return;
          accepted = true;
          clearTimeout(timeout);
          this.#connected = true;
          this.#everConnected = true;
          if (resolveReady) this.#ready.resolve();
          this.#startKeepalive();
          opened.resolve();
        });
      } catch (error) {
        opened.reject(error);
        socket.close(1002, "Invalid MQTT packet");
      }
    });
    socket.addEventListener("error", () => {
      if (!accepted) {
        opened.reject(new Error("MQTT WebSocket failed"));
        socket.close();
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      const wasConnected = this.#connected;
      this.#connected = false;
      this.#stopKeepalive();
      if (!accepted)
        opened.reject(new Error("MQTT broker closed before CONNACK"));
      if (this.#ending) return;
      if (!this.#everConnected) {
        const error = new Error("MQTT connection closed");
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        return;
      }
      if (this.options.reconnectPeriod <= 0) {
        const error = new Error("MQTT connection closed");
        this.#ready.reject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        return;
      }
      if (wasConnected) this.#ready = deferred<void>();
      this.#scheduleReconnect();
    });
    return opened.promise;
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer !== null || this.#ending) return;
    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null;
      try {
        await this.#open(false);
        for (const topic of this.#subscriptions)
          this.#sendSubscribe(this.#nextPacketId(), topic, false);
        for (const pending of this.#pending.values()) {
          if (pending.kind === "publish") {
            const resend = pending.packet.slice();
            resend[0] |= 0x08;
            send(this.#socket, resend);
          } else {
            send(this.#socket, pending.packet);
          }
        }
        this.#ready.resolve();
      } catch {
        this.#socket?.close();
        this.#scheduleReconnect();
      }
    }, this.options.reconnectPeriod);
  }

  #startKeepalive() {
    this.#stopKeepalive();
    this.#keepaliveTimer = setInterval(
      () => {
        if (!this.#connected) return;
        if (this.#waitingForPing) {
          this.#socket?.close();
          return;
        }
        this.#waitingForPing = true;
        send(this.#socket, Uint8Array.of(0xc0, 0));
      },
      (KEEPALIVE_SECONDS * 1000) / 2,
    );
  }

  #stopKeepalive() {
    if (this.#keepaliveTimer !== null) clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
    this.#waitingForPing = false;
  }

  #nextPacketId(): number {
    do this.#packetId = (this.#packetId % 0xffff) + 1;
    while (this.#pending.has(this.#packetId));
    return this.#packetId;
  }

  #receive(bytes: Uint8Array, onConnect: () => void) {
    if (this.#buffer.length + bytes.length > MAX_PACKET_BYTES)
      throw new Error("MQTT buffered packet is too large");
    this.#buffer = concatenate([this.#buffer, bytes]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      let multiplier = 1;
      let length = 0;
      let cursor = 1;
      let encoded: number;
      do {
        if (cursor > 4) throw new Error("Invalid MQTT remaining length");
        if (cursor >= this.#buffer.length) return;
        encoded = this.#buffer[cursor++];
        length += (encoded & 0x7f) * multiplier;
        multiplier *= 128;
      } while ((encoded & 0x80) !== 0);
      if (length > MAX_REMAINING_LENGTH || length + cursor > MAX_PACKET_BYTES)
        throw new Error("MQTT packet is too large");
      const end = cursor + length;
      if (this.#buffer.length < end) return;
      const header = this.#buffer[0];
      const body = this.#buffer.slice(cursor, end);
      this.#buffer = this.#buffer.slice(end);
      this.#handlePacket(header, body, onConnect);
    }
  }

  #handlePacket(header: number, body: Uint8Array, onConnect: () => void) {
    const kind = header >> 4;
    if (kind === 2) {
      if ((header & 0x0f) !== 0 || body.length !== 2 || body[1] !== 0)
        throw new Error(`MQTT CONNACK refused (${body[1] ?? "invalid"})`);
      onConnect();
      return;
    }
    if (kind === 13) {
      if ((header & 0x0f) !== 0 || body.length !== 0)
        throw new Error("Invalid MQTT PINGRESP");
      this.#waitingForPing = false;
      return;
    }
    if (kind === 4 || kind === 9) {
      const expectedLength = kind === 4 ? 2 : 3;
      if ((header & 0x0f) !== 0 || body.length !== expectedLength)
        throw new Error(`Invalid MQTT ${kind === 4 ? "PUBACK" : "SUBACK"}`);
      const id = (body[0] << 8) | body[1];
      const pending = this.#pending.get(id);
      if (!pending) return;
      const expectedKind = kind === 4 ? "publish" : "subscribe";
      if (pending.kind !== expectedKind)
        throw new Error(`MQTT ${expectedKind} acknowledgement mismatch`);
      if (kind === 9 && body[2] === 0x80) {
        pending.reject(new Error("MQTT subscription was refused"));
      } else {
        pending.resolve((kind === 9 ? [body[2]] : undefined) as never);
      }
      this.#pending.delete(id);
      return;
    }
    if (kind !== 3 || body.length < 2) return;
    const topicLength = (body[0] << 8) | body[1];
    if (topicLength === 0 || body.length < 2 + topicLength)
      throw new Error("Invalid MQTT publish topic");
    const topic = decodeText(body.slice(2, 2 + topicLength));
    const qos = (header >> 1) & 0x03;
    if (qos > 1) throw new Error("Unsupported MQTT publish QoS");
    let offset = 2 + topicLength;
    if (qos > 0) {
      if (body.length < offset + 2) return;
      const id = (body[offset] << 8) | body[offset + 1];
      offset += 2;
      if (qos === 1) send(this.#socket, mqttPacket(0x40, twoByte(id)));
    }
    const payload = body.slice(offset);
    for (const listener of this.#listeners) listener(topic, payload);
  }

  #sendSubscribe(
    id: number,
    topic: string,
    tracked: boolean,
  ): Promise<number[]> {
    const bytes = subscribePacket(id, topic);
    if (!tracked) {
      send(this.#socket, bytes);
      return Promise.resolve([1]);
    }
    const done = deferred<number[]>();
    this.#pending.set(id, {
      kind: "subscribe",
      packet: bytes,
      ...done,
    } as Pending);
    send(this.#socket, bytes);
    return done.promise;
  }

  async subscribeAsync(topic: string, _options: { qos: 1 }): Promise<number[]> {
    await this.#ready.promise;
    if (this.#pending.size >= MAX_IN_FLIGHT)
      throw new Error("MQTT has too many in-flight packets");
    const result = await this.#sendSubscribe(this.#nextPacketId(), topic, true);
    this.#subscriptions.add(topic);
    return result;
  }

  async publishAsync(
    topic: string,
    payload: string,
    _options: { qos: 1; retain: false },
  ): Promise<void> {
    await this.#ready.promise;
    if (this.#pending.size >= MAX_IN_FLIGHT)
      throw new Error("MQTT has too many in-flight packets");
    const id = this.#nextPacketId();
    const bytes = publishPacket(id, topic, payload);
    if (bytes.length > MAX_PACKET_BYTES)
      throw new Error("MQTT publish is too large");
    const done = deferred<void>();
    this.#pending.set(id, {
      kind: "publish",
      packet: bytes,
      ...done,
    } as Pending);
    send(this.#socket, bytes);
    await done.promise;
  }

  on(_event: "message", listener: Listener) {
    this.#listeners.add(listener);
  }

  off(_event: "message", listener: Listener) {
    this.#listeners.delete(listener);
  }

  async endAsync(_force: true): Promise<void> {
    this.#ending = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#stopKeepalive();
    if (this.#connected) send(this.#socket, Uint8Array.of(0xe0, 0));
    this.#socket?.close();
    const error = new Error("MQTT client is closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#listeners.clear();
  }
}

export async function connectAsync(
  url: string,
  options: MqttBrowserOptions,
  _allowRetries = true,
): Promise<MqttBrowserClient> {
  const client = new BrowserMqttClient(url, options);
  await client.start();
  return client;
}
