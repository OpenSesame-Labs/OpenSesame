import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import type { CallbackRequest, FetchLike } from "../src/contract.js";

export const SLACK_STANDIN_API_BASE = "https://slack.standin.example.test/api";

export interface SlackStandInOptions {
  /** Synthetic values shared only with the adapter under test. */
  botToken: string;
  signingSecret: string;
}

export type SlackStandInFault =
  | { kind: "http"; status: number }
  | { kind: "api"; error: string }
  | { kind: "transport" };

export interface SlackStandInMessage {
  channel: string;
  ts: string;
  text: string;
  blocks: JsonValue[];
}

export interface SlackStandInRequest {
  method: string;
  path: string;
  authorized: boolean;
  body: string;
}

export interface SlackStandInInteraction {
  channel: string;
  ts: string;
  actionId: string;
  teamId: string;
  userId: string;
  /** Seconds since the epoch, explicitly supplied for deterministic tests. */
  timestamp: number;
}

export interface SlackStandIn {
  readonly apiBaseUrl: string;
  readonly fetchImpl: FetchLike;
  readonly messages: readonly SlackStandInMessage[];
  /** Request bodies may contain decision tokens; only use synthetic test data. */
  readonly requests: readonly SlackStandInRequest[];
  /** Queue a failure for the next authenticated request to a supported route. */
  failNext(fault: SlackStandInFault): void;
  /** Form-encode and sign an interaction with an existing message button. */
  signedInteraction(
    interaction: SlackStandInInteraction,
  ): Promise<CallbackRequest>;
  reset(): void;
  close(): Promise<void>;
}

function apiError(error: string): Response {
  return Response.json({ ok: false, error });
}

function parseBody(text: string): JsonObject | undefined {
  try {
    const value: BoundaryValue = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function buttonValue(
  message: SlackStandInMessage,
  actionId: string,
): string | undefined {
  for (const entry of message.blocks) {
    const block = readJsonObject(entry);
    if (readString(block?.type) !== "actions") continue;
    const elements = block?.elements;
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      const button = readJsonObject(element);
      if (
        readString(button?.type) === "button" &&
        readString(button?.action_id) === actionId
      ) {
        return readString(button?.value);
      }
    }
  }
  return undefined;
}

async function signCallback(
  secret: string,
  timestamp: number,
  body: Uint8Array,
): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const input = new Uint8Array(prefix.length + body.length);
  input.set(prefix);
  input.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, input);
  return `v0=${Buffer.from(signature).toString("hex")}`;
}

type CancelBodyRead = (reason: Error) => void;

async function readRequestBody(
  request: Request,
  pending: Set<CancelBodyRead>,
): Promise<string> {
  if (request.signal.aborted)
    throw new DOMException("Request aborted", "AbortError");
  if (!request.body) return "";
  const reader = request.body.getReader();
  let rejectCancelled = (_reason: Error) => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  let interrupted = false;
  const cancel = (reason: Error) => {
    if (interrupted) return;
    interrupted = true;
    pending.delete(cancel);
    rejectCancelled(reason);
    // A producer may never resolve its cancel callback. The request must still
    // settle promptly and the cancellation rejection must never go unhandled.
    void reader.cancel(reason).catch(() => undefined);
  };
  const onAbort = () =>
    cancel(new DOMException("Request aborted", "AbortError"));
  pending.add(cancel);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const read = async () => {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    return await Promise.race([read(), cancelled]);
  } finally {
    pending.delete(cancel);
    request.signal.removeEventListener("abort", onAbort);
    if (!interrupted) reader.releaseLock();
  }
}

/** A local, deliberately partial Slack counterparty. It never calls global fetch. */
export function createSlackStandIn(options: SlackStandInOptions): SlackStandIn {
  if (!options.botToken || !options.signingSecret) {
    throw new Error(
      "Slack stand-in requires a test bot token and signing secret",
    );
  }
  const { botToken, signingSecret } = options;
  const messages: SlackStandInMessage[] = [];
  const requests: SlackStandInRequest[] = [];
  const faults: SlackStandInFault[] = [];
  const pendingReads = new Set<CancelBodyRead>();
  const origin = new URL(SLACK_STANDIN_API_BASE).origin;
  let sequence = 0;
  let closed = false;
  let generation = 0;
  const assertOpen = () => {
    if (closed) throw new Error("Slack stand-in is closed");
  };
  const clear = (reason: Error) => {
    generation += 1;
    for (const cancel of pendingReads) cancel(reason);
    messages.length = 0;
    requests.length = 0;
    faults.length = 0;
    sequence = 0;
  };
  const reset = () => {
    assertOpen();
    clear(new Error("Slack stand-in was reset during a request"));
  };
  const fetchImpl: FetchLike = async (input, init) => {
    assertOpen();
    const startedIn = generation;
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (
      target.origin !== origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    ) {
      throw new TypeError("Slack stand-in refuses non-local target");
    }
    const bodyText = await readRequestBody(request, pendingReads);
    assertOpen();
    if (generation !== startedIn)
      throw new Error("Slack stand-in was reset during a request");
    if (request.signal.aborted)
      throw new DOMException("Request aborted", "AbortError");
    const authorized =
      request.headers.get("authorization") === `Bearer ${botToken}`;
    requests.push({
      method: request.method,
      path: target.pathname,
      authorized,
      body: bodyText,
    });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (
      target.pathname !== "/api/chat.postMessage" &&
      target.pathname !== "/api/chat.update"
    ) {
      return new Response(null, { status: 404 });
    }
    if (!authorized) return apiError("invalid_auth");
    const fault = faults.shift();
    if (fault?.kind === "transport")
      throw new TypeError("stand-in transport failure");
    if (fault?.kind === "http")
      return new Response(null, { status: fault.status });
    if (fault?.kind === "api") return apiError(fault.error);
    const contentType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return apiError("invalid_arguments");
    }
    const body = parseBody(bodyText);
    const channel = readString(body?.channel);
    const text = readString(body?.text);
    const blocks = body?.blocks;
    if (
      !channel ||
      !text ||
      !Array.isArray(blocks) ||
      !blocks.every(isJsonObject)
    ) {
      return apiError("invalid_arguments");
    }
    if (target.pathname === "/api/chat.postMessage") {
      sequence += 1;
      const ts = `1.${String(sequence).padStart(6, "0")}`;
      messages.push({ channel, ts, text, blocks: structuredClone(blocks) });
      return Response.json({ ok: true, channel, ts });
    }
    const ts = readString(body?.ts);
    const message = messages.find(
      (item) => item.channel === channel && item.ts === ts,
    );
    if (!message) return apiError("message_not_found");
    message.text = text;
    message.blocks = structuredClone(blocks);
    return Response.json({ ok: true, channel, ts });
  };
  return {
    apiBaseUrl: SLACK_STANDIN_API_BASE,
    fetchImpl,
    get messages() {
      return structuredClone(messages);
    },
    get requests() {
      return structuredClone(requests);
    },
    failNext(fault) {
      assertOpen();
      if (
        fault.kind === "http" &&
        (!Number.isInteger(fault.status) ||
          fault.status < 400 ||
          fault.status > 599)
      ) {
        throw new Error("stand-in HTTP fault must be a 4xx or 5xx status");
      }
      faults.push(structuredClone(fault));
    },
    async signedInteraction(interaction) {
      assertOpen();
      const startedIn = generation;
      const { channel, ts, actionId, teamId, userId, timestamp } = interaction;
      if (!teamId || !userId || !Number.isSafeInteger(timestamp)) {
        throw new Error(
          "stand-in interaction requires identities and a valid timestamp",
        );
      }
      const message = messages.find(
        (item) => item.channel === channel && item.ts === ts,
      );
      const value = message && buttonValue(message, actionId);
      if (!value)
        throw new Error("stand-in message has no such decision button");
      const payload = JSON.stringify({
        type: "block_actions",
        team: { id: teamId },
        user: { id: userId },
        actions: [{ action_id: actionId, value, type: "button" }],
      });
      const rawBody = new TextEncoder().encode(
        new URLSearchParams({ payload }).toString(),
      );
      const signature = await signCallback(signingSecret, timestamp, rawBody);
      assertOpen();
      if (generation !== startedIn)
        throw new Error("Slack stand-in was reset during signing");
      return {
        rawBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": signature,
        },
      };
    },
    reset,
    async close() {
      if (!closed) {
        closed = true;
        clear(new Error("Slack stand-in is closed"));
      }
    },
  };
}
