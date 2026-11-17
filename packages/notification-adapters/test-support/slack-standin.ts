import {
  type JsonValue,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import type { CallbackRequest, FetchLike } from "../src/contract.js";
import {
  type SlackStandInState,
  assertOpen,
  clear,
  createFetch,
  createState,
} from "./slack-standin-transport.js";

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

async function signedInteraction(
  state: SlackStandInState,
  interaction: SlackStandInInteraction,
): Promise<CallbackRequest> {
  assertOpen(state);
  const startedIn = state.generation;
  const { channel, ts, actionId, teamId, userId, timestamp } = interaction;
  if (!teamId || !userId || !Number.isSafeInteger(timestamp)) {
    throw new Error(
      "stand-in interaction requires identities and a valid timestamp",
    );
  }
  const message = state.messages.find(
    (item) => item.channel === channel && item.ts === ts,
  );
  const value = message && buttonValue(message, actionId);
  if (!value) throw new Error("stand-in message has no such decision button");
  const payload = JSON.stringify({
    type: "block_actions",
    team: { id: teamId },
    user: { id: userId },
    actions: [{ action_id: actionId, value, type: "button" }],
  });
  const rawBody = new TextEncoder().encode(
    new URLSearchParams({ payload }).toString(),
  );
  const signature = await signCallback(state.signingSecret, timestamp, rawBody);
  assertOpen(state);
  if (state.generation !== startedIn)
    throw new Error("Slack stand-in was reset during signing");
  return {
    rawBody,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
  };
}

/** A local, deliberately partial Slack counterparty. It never calls global fetch. */
export function createSlackStandIn(options: SlackStandInOptions): SlackStandIn {
  if (!options.botToken || !options.signingSecret) {
    throw new Error(
      "Slack stand-in requires a test bot token and signing secret",
    );
  }
  const state = createState(options, SLACK_STANDIN_API_BASE);
  return {
    apiBaseUrl: SLACK_STANDIN_API_BASE,
    fetchImpl: createFetch(state),
    get messages() {
      return structuredClone(state.messages);
    },
    get requests() {
      return structuredClone(state.requests);
    },
    failNext(fault) {
      assertOpen(state);
      if (
        fault.kind === "http" &&
        (!Number.isInteger(fault.status) ||
          fault.status < 400 ||
          fault.status > 599)
      ) {
        throw new Error("stand-in HTTP fault must be a 4xx or 5xx status");
      }
      state.faults.push(structuredClone(fault));
    },
    signedInteraction: (interaction) => signedInteraction(state, interaction),
    reset() {
      assertOpen(state);
      clear(state, new Error("Slack stand-in was reset during a request"));
    },
    async close() {
      if (!state.closed) {
        state.closed = true;
        clear(state, new Error("Slack stand-in is closed"));
      }
    },
  };
}
