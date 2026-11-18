/** The bounded NATS Service v1 surface exposed by an owner live-session tab. */
import type { Msg, NatsConnection, Subscription } from "@nats-io/nats-core";

const NAME = "opensesame-live";
const VERSION = "1.0.0";
const METADATA = Object.freeze({ protocol: "osm-live-v1" });
const encoder = new TextEncoder();

function serviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reply(message: Msg, value: unknown): void {
  message.respond(encoder.encode(JSON.stringify(value)));
}

/** Register discovery plus the product's one `info` endpoint. */
export function serveNatsSession(
  connection: NatsConnection,
  base: string,
): () => void {
  const id = serviceId();
  const started = new Date().toISOString();
  const subscriptions: Subscription[] = [];
  let requests = 0;
  let processing = 0;

  const endpoint = {
    name: "info",
    subject: `${base}.info`,
    queue_group: "",
  };
  const identity = { name: NAME, id, version: VERSION, metadata: METADATA };
  const info = () => ({
    type: "io.nats.micro.v1.info_response",
    ...identity,
    description: "An OpenSesame live session, served by the owner's tab",
    endpoints: [endpoint],
  });
  const stats = () => ({
    type: "io.nats.micro.v1.stats_response",
    ...identity,
    started,
    endpoints: [
      {
        ...endpoint,
        average_processing_time:
          requests === 0 ? 0 : Math.round(processing / requests),
        num_errors: 0,
        num_requests: requests,
        processing_time: processing,
      },
    ],
  });
  const ping = Object.freeze({
    type: "io.nats.micro.v1.ping_response",
    ...identity,
  });

  const subscribe = (subject: string, handler: (message: Msg) => void) => {
    subscriptions.push(
      connection.subscribe(subject, {
        callback(error, message) {
          if (!error && message) handler(message);
        },
      }),
    );
  };
  subscribe(endpoint.subject, (message) => {
    const before = performance.now();
    reply(message, { live: true });
    requests += 1;
    processing += Math.round((performance.now() - before) * 1_000_000);
  });
  for (const [verb, response] of [
    ["PING", () => ping],
    ["INFO", info],
    ["STATS", stats],
  ] as const) {
    for (const suffix of ["", `.${NAME}`, `.${NAME}.${id}`])
      subscribe(`$SRV.${verb}${suffix}`, (message) =>
        reply(message, response()),
      );
  }
  return () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
  };
}
