import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import type { FetchLike } from "../src/contract.js";
import type {
  SlackStandInFault,
  SlackStandInMessage,
  SlackStandInOptions,
  SlackStandInRequest,
} from "./slack-standin.js";

type CancelBodyRead = (reason: Error) => void;

export interface SlackStandInState {
  readonly botToken: string;
  readonly signingSecret: string;
  readonly origin: string;
  readonly messages: SlackStandInMessage[];
  readonly requests: SlackStandInRequest[];
  readonly faults: SlackStandInFault[];
  readonly pendingReads: Set<CancelBodyRead>;
  sequence: number;
  closed: boolean;
  generation: number;
}

export function createState(
  options: SlackStandInOptions,
  apiBaseUrl: string,
): SlackStandInState {
  return {
    botToken: options.botToken,
    signingSecret: options.signingSecret,
    origin: new URL(apiBaseUrl).origin,
    messages: [],
    requests: [],
    faults: [],
    pendingReads: new Set(),
    sequence: 0,
    closed: false,
    generation: 0,
  };
}

export function assertOpen(state: SlackStandInState): void {
  if (state.closed) throw new Error("Slack stand-in is closed");
}

export function clear(state: SlackStandInState, reason: Error): void {
  state.generation += 1;
  for (const cancel of state.pendingReads) cancel(reason);
  state.messages.length = 0;
  state.requests.length = 0;
  state.faults.length = 0;
  state.sequence = 0;
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

function assertLocalTarget(target: URL, origin: string): void {
  if (
    target.origin !== origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new TypeError("Slack stand-in refuses non-local target");
  }
}

function faultResponse(
  fault: SlackStandInFault | undefined,
): Response | undefined {
  if (fault?.kind === "transport")
    throw new TypeError("stand-in transport failure");
  if (fault?.kind === "http")
    return new Response(null, { status: fault.status });
  if (fault?.kind === "api") return apiError(fault.error);
  return undefined;
}

function messageResponse(
  state: SlackStandInState,
  request: Request,
  path: string,
  bodyText: string,
): Response {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") return apiError("invalid_arguments");
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
  if (path === "/api/chat.postMessage") {
    state.sequence += 1;
    const ts = `1.${String(state.sequence).padStart(6, "0")}`;
    state.messages.push({ channel, ts, text, blocks: structuredClone(blocks) });
    return Response.json({ ok: true, channel, ts });
  }
  const ts = readString(body?.ts);
  const message = state.messages.find(
    (item) => item.channel === channel && item.ts === ts,
  );
  if (!message) return apiError("message_not_found");
  message.text = text;
  message.blocks = structuredClone(blocks);
  return Response.json({ ok: true, channel, ts });
}

function respond(
  state: SlackStandInState,
  request: Request,
  path: string,
  bodyText: string,
): Response {
  const authorized =
    request.headers.get("authorization") === `Bearer ${state.botToken}`;
  state.requests.push({
    method: request.method,
    path,
    authorized,
    body: bodyText,
  });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (path !== "/api/chat.postMessage" && path !== "/api/chat.update") {
    return new Response(null, { status: 404 });
  }
  if (!authorized) return apiError("invalid_auth");
  const fault = faultResponse(state.faults.shift());
  return fault ?? messageResponse(state, request, path, bodyText);
}

export function createFetch(state: SlackStandInState): FetchLike {
  return async (input, init) => {
    assertOpen(state);
    const startedIn = state.generation;
    const request = new Request(input, init);
    const target = new URL(request.url);
    assertLocalTarget(target, state.origin);
    const bodyText = await readRequestBody(request, state.pendingReads);
    assertOpen(state);
    if (state.generation !== startedIn)
      throw new Error("Slack stand-in was reset during a request");
    if (request.signal.aborted)
      throw new DOMException("Request aborted", "AbortError");
    return respond(state, request, target.pathname, bodyText);
  };
}
