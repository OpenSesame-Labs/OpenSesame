import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { natsSeams } from "../nats.js";
import {
  MemoryTaskBus,
  NatsJetStreamTaskBus,
  createTaskBusFromEnv,
  eventSubject,
  outboxToBusEvent,
  resolveTaskBusBackend,
} from "../taskBus.js";

describe("taskBus", () => {
  describe("taskBus", () => {
    it("defaults to memory without NATS env", () => {
      expect(resolveTaskBusBackend({})).toBe("memory");
    });

    it("selects nats when NATS_URL is set", () => {
      expect(resolveTaskBusBackend({ NATS_URL: "nats://127.0.0.1:4222" })).toBe(
        "nats",
      );
    });

    it("requires NATS_URL for explicit nats", () => {
      expect(() =>
        resolveTaskBusBackend({ OPENSESAME_TASKBUS: "nats" }),
      ).toThrow(/NATS_URL/);
    });

    it("maps outbox rows to CloudEvents subjects under opensesame.events", () => {
      const event = outboxToBusEvent({
        id: "e1",
        eventType: "principal.created",
        aggregateType: "principal",
        aggregateId: "prn_1",
        payload: { ok: true },
        createdAt: new Date("2026-08-17T00:00:00Z"),
      });
      expect(eventSubject(event.type)).toBe(
        "opensesame.events.principal.created",
      );
    });

    it("memory bus records publishes", async () => {
      const bus = new MemoryTaskBus();
      await bus.publish({
        id: "1",
        specversion: "1.0",
        source: "test",
        type: "t",
        time: "2026-08-17T00:00:00Z",
        data: {},
      });
      expect(bus.published).toHaveLength(1);
    });
  });
});

describe("env", () => {
  const connect = vi.fn();

  beforeEach(() => {
    natsSeams.connect = overlapCast(connect);
    natsSeams.StringCodec = overlapCast(() => ({
      encode: (value: string) => new TextEncoder().encode(value),
      decode: (value: Uint8Array) => new TextDecoder().decode(value),
    }));
  });

  describe("resolveTaskBusBackend variants", () => {
    it("accepts the documented memory spellings", () => {
      expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "memory" })).toBe(
        "memory",
      );
      expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "inmemory" })).toBe(
        "memory",
      );
      expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "in-memory" })).toBe(
        "memory",
      );
    });

    it("accepts jetstream as an alias for nats, case- and space-insensitively", () => {
      expect(
        resolveTaskBusBackend({
          OPENSESAME_TASKBUS: " JetStream ",
          NATS_URL: "nats://127.0.0.1:4222",
        }),
      ).toBe("nats");
      expect(
        resolveTaskBusBackend({
          OPENSESAME_TASKBUS: "NATS",
          NATS_URL: "nats://127.0.0.1:4222",
        }),
      ).toBe("nats");
    });

    it("rejects unknown backends with a helpful message", () => {
      expect(() =>
        resolveTaskBusBackend({ OPENSESAME_TASKBUS: "kafka" }),
      ).toThrow(/unknown OPENSESAME_TASKBUS=kafka; expected memory\|nats/);
    });

    it("lets an explicit memory selection win over a set NATS_URL", () => {
      expect(
        resolveTaskBusBackend({
          OPENSESAME_TASKBUS: "memory",
          NATS_URL: "nats://127.0.0.1:4222",
        }),
      ).toBe("memory");
    });
  });

  describe("createTaskBusFromEnv", () => {
    afterEach(() => {
      vi.resetAllMocks();
    });

    it("builds an in-memory bus without opening sockets", async () => {
      const bus = await createTaskBusFromEnv({});
      expect(bus).toBeInstanceOf(MemoryTaskBus);
      expect(connect).not.toHaveBeenCalled();
    });

    it("builds a JetStream bus from NATS_URL alone", async () => {
      connect.mockResolvedValue({
        drain: vi.fn().mockResolvedValue(undefined),
        jetstreamManager: vi.fn().mockResolvedValue({
          streams: {
            info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
          },
        }),
        jetstream: vi.fn().mockReturnValue({ publish: vi.fn() }),
      });

      const bus = await createTaskBusFromEnv({
        NATS_URL: "nats://127.0.0.1:4222",
      });
      expect(bus).toBeInstanceOf(NatsJetStreamTaskBus);
      expect(connect).toHaveBeenCalledWith({
        servers: "nats://127.0.0.1:4222",
        name: "opensesame-worker",
      });
    });
  });

  describe("NatsJetStreamTaskBus.close", () => {
    afterEach(() => {
      vi.resetAllMocks();
    });

    it("drains the connection", async () => {
      const drain = vi.fn().mockResolvedValue(undefined);
      connect.mockResolvedValue({
        drain,
        jetstreamManager: vi.fn().mockResolvedValue({
          streams: {
            info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
          },
        }),
        jetstream: vi.fn().mockReturnValue({ publish: vi.fn() }),
      });

      const bus = await NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222");
      await bus.close();
      expect(drain).toHaveBeenCalledTimes(1);
    });
  });

  describe("eventSubject", () => {
    it("strips a leading dot from the event type", () => {
      expect(eventSubject(".principal.created")).toBe(
        "opensesame.events.principal.created",
      );
    });
  });
});

describe("jetstream", () => {
  const connect = vi.fn();
  const jetstreamManager = vi.fn();
  const jetstream = vi.fn();

  beforeEach(() => {
    natsSeams.connect = overlapCast(connect);
    natsSeams.StringCodec = overlapCast(() => ({
      encode: (value: string) => new TextEncoder().encode(value),
      decode: (value: Uint8Array) => new TextDecoder().decode(value),
    }));
  });

  describe("NatsJetStreamTaskBus", () => {
    afterEach(() => {
      vi.resetAllMocks();
    });

    it("fails loudly when OPENSESAME_EVENTS stream is missing", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      connect.mockResolvedValue({
        close,
        jetstreamManager: jetstreamManager.mockResolvedValue({
          streams: {
            info: vi.fn().mockRejectedValue(new Error("stream not found")),
          },
        }),
        jetstream: jetstream.mockReturnValue({}),
      });

      await expect(
        NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222"),
      ).rejects.toThrow(/JetStream stream OPENSESAME_EVENTS missing/);
      expect(close).toHaveBeenCalled();
    });

    it("publishes via JetStream when stream exists", async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      connect.mockResolvedValue({
        drain: vi.fn().mockResolvedValue(undefined),
        jetstreamManager: jetstreamManager.mockResolvedValue({
          streams: {
            info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
          },
        }),
        jetstream: jetstream.mockReturnValue({ publish }),
      });

      const bus = await NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222");
      await bus.publish({
        id: "e1",
        specversion: "1.0",
        source: "test",
        type: "principal.created",
        time: "2026-08-17T00:00:00Z",
        data: { ok: true },
      });
      expect(publish).toHaveBeenCalledWith(
        "opensesame.events.principal.created",
        expect.any(Uint8Array),
        { msgID: "e1", expect: { streamName: "OPENSESAME_EVENTS" } },
      );
    });
  });
});
