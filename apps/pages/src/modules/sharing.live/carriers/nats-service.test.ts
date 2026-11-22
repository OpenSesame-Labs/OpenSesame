import type { Msg, NatsConnection, Subscription } from "@nats-io/nats-core";
import { ServiceResponseType } from "@nats-io/services";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { serveNatsSession } from "./nats-service.js";

type Callback = (error: Error | null, message: Msg) => void;

function fixture() {
  const callbacks = new Map<string, Callback>();
  const stops: string[] = [];
  const connection: NatsConnection = overlapCast({
    subscribe(subject: string, options: { callback: Callback }) {
      callbacks.set(subject, options.callback);
      const subscription: Subscription = overlapCast({
        unsubscribe() {
          stops.push(subject);
        },
      });
      return subscription;
    },
  });
  const request = (subject: string) => {
    const responses: Uint8Array[] = [];
    const message: Msg = overlapCast({
      respond(value: Uint8Array) {
        responses.push(value);
        return true;
      },
    });
    callbacks.get(subject)?.(null, message);
    expect(responses).toHaveLength(1);
    return JSON.parse(new TextDecoder().decode(responses[0]));
  };
  return { callbacks, connection, request, stops };
}

describe("bounded NATS service discovery", () => {
  it("answers official ping, info, stats and product endpoint schemas", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    const { callbacks, connection, request } = fixture();
    serveNatsSession(connection, "opensesame.live.topic");
    const ping = request("$SRV.PING");
    expect(ping).toMatchObject({
      type: ServiceResponseType.PING,
      name: "opensesame-live",
      version: "1.0.0",
      metadata: { protocol: "osm-live-v1" },
    });
    const info = request(`$SRV.INFO.opensesame-live.${ping.id}`);
    expect(info).toMatchObject({
      type: ServiceResponseType.INFO,
      id: ping.id,
      endpoints: [{ name: "info", subject: "opensesame.live.topic.info" }],
    });
    expect(request("opensesame.live.topic.info")).toEqual({ live: true });
    expect(request("$SRV.STATS.opensesame-live")).toMatchObject({
      type: ServiceResponseType.STATS,
      endpoints: [{ num_requests: 1, num_errors: 0 }],
    });
    expect(callbacks).toHaveLength(10);
    vi.unstubAllGlobals();
  });

  it("unsubscribes every discovery and endpoint subject", () => {
    const { connection, stops } = fixture();
    const stop = serveNatsSession(connection, "opensesame.live.topic");
    stop();
    expect(stops).toHaveLength(10);
  });
});
