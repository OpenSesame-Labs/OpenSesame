import { describe, expect, it, vi } from "vitest";
import { type RenderInput, createSlackAdapter } from "../src/index.js";
import { createSlackStandIn } from "./index.js";

const TOKEN = "stand-in-bot-key";
const SECRET = "stand-in-signing-key";
const NOW = new Date("2026-11-17T00:00:00.000Z");
const TIMESTAMP = 1794873600;
const INPUT: RenderInput = {
  kind: "slack",
  confidentiality: "descriptive",
  notificationClass: "authorization_request",
  eventType: "authority.invocation.requested",
  rendezvousRef: "review-1",
  decisionTokens: { approve: "opaque-approve", deny: "opaque-deny" },
};
const DESTINATION = {
  channel: "slack",
  teamId: "T_TEST",
  userId: "U_TEST",
} as const;

function setup(botToken = TOKEN, signingSecret = SECRET) {
  const standIn = createSlackStandIn({
    botToken: TOKEN,
    signingSecret: SECRET,
  });
  const adapter = createSlackAdapter({
    botToken,
    signingSecret,
    apiBaseUrl: standIn.apiBaseUrl,
    fetchImpl: standIn.fetchImpl,
    now: () => NOW,
  });
  return { standIn, adapter };
}

describe("Slack stand-in", () => {
  it("accepts a real adapter message and signs the actual button's form bytes", async () => {
    const { standIn, adapter } = setup();
    const outcome = await adapter.deliver(adapter.render(INPUT), DESTINATION);
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageRef: "U_TEST:1.000001",
    });
    expect(standIn.requests).toHaveLength(1);
    expect(standIn.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/chat.postMessage",
      authorized: true,
    });
    expect(JSON.stringify(standIn.requests)).not.toContain(TOKEN);
    const callback = await standIn.signedInteraction({
      channel: "U_TEST",
      ts: "1.000001",
      actionId: "opensesame_approve",
      teamId: "T_TEST",
      userId: "U_TEST",
      timestamp: TIMESTAMP,
    });
    // Expected digest computed independently with Python's hmac/hashlib.
    expect(callback.headers["x-slack-signature"]).toBe(
      "v0=dac26798c0071cba777d2b388752d7e72969776ffb2f6a5daa00b762544ab9d4",
    );
    expect(new TextDecoder().decode(callback.rawBody)).toMatch(/^payload=%7B/u);
    expect(adapter.verifyCallback?.(callback)).toMatchObject({
      ok: true,
      providerId: "slack",
      providerTenantId: "T_TEST",
      providerSubjectId: "U_TEST",
      decision: "approved",
      opaqueRef: "opaque-approve",
      fresh: true,
    });
    const altered = new Uint8Array(callback.rawBody);
    altered[altered.length - 1] = 0x21;
    expect(adapter.verifyCallback?.({ ...callback, rawBody: altered })).toEqual(
      {
        ok: false,
        reason: "signature_mismatch",
      },
    );
    expect(
      adapter.verifyCallback?.({
        ...callback,
        now: new Date(NOW.getTime() + 301_000),
      }),
    ).toEqual({
      ok: false,
      reason: "timestamp_stale",
    });
    await standIn.close();
  });

  it("rejects wrong bot credentials and callbacks signed under another key", async () => {
    const badBot = setup("wrong-token");
    await expect(
      badBot.adapter.deliver(badBot.adapter.render(INPUT), DESTINATION),
    ).resolves.toEqual({
      status: "permanent",
      error: "invalid_auth",
    });
    expect(badBot.standIn.messages).toHaveLength(0);
    const { standIn, adapter } = setup();
    await adapter.deliver(adapter.render(INPUT), DESTINATION);
    const callback = await standIn.signedInteraction({
      channel: "U_TEST",
      ts: "1.000001",
      actionId: "opensesame_approve",
      teamId: "T_TEST",
      userId: "U_TEST",
      timestamp: TIMESTAMP,
    });
    const wrongSigner = setup(TOKEN, "another-signing-key");
    expect(wrongSigner.adapter.verifyCallback?.(callback)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
    await badBot.standIn.close();
    await standIn.close();
    await wrongSigner.standIn.close();
  });

  it("simulates provider and transport failures without network fallback", async () => {
    const { standIn, adapter } = setup();
    const message = adapter.render(INPUT);
    standIn.failNext({ kind: "http", status: 503 });
    await expect(adapter.deliver(message, DESTINATION)).resolves.toEqual({
      status: "retryable",
      error: "status:503",
    });
    standIn.failNext({ kind: "api", error: "channel_not_found" });
    await expect(adapter.deliver(message, DESTINATION)).resolves.toEqual({
      status: "permanent",
      error: "channel_not_found",
    });
    standIn.failNext({ kind: "transport" });
    await expect(adapter.deliver(message, DESTINATION)).resolves.toEqual({
      status: "retryable",
      error: "transport:TypeError",
    });
    expect(standIn.messages).toHaveLength(0);
    await expect(
      standIn.fetchImpl("https://example.com/api/chat.postMessage", {
        method: "POST",
      }),
    ).rejects.toThrow(/refuses/);
    expect(
      (
        await standIn.fetchImpl(`${standIn.apiBaseUrl}/unsupported`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    const invalid = await standIn.fetchImpl(
      `${standIn.apiBaseUrl}/chat.postMessage`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "text/plain",
        },
        body: "{}",
      },
    );
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "invalid_arguments",
    });
    expect(standIn.messages).toHaveLength(0);
    await standIn.close();
  });

  it("removes decision buttons on update and isolates/reset instances", async () => {
    const { standIn, adapter } = setup();
    const other = setup().standIn;
    const message = adapter.render(INPUT);
    await adapter.deliver(message, DESTINATION);
    expect(other.messages).toHaveLength(0);
    await expect(adapter.update?.("U_TEST:1.000001", message)).resolves.toEqual(
      {
        status: "delivered",
        providerMessageRef: "U_TEST:1.000001",
      },
    );
    await expect(
      standIn.signedInteraction({
        channel: "U_TEST",
        ts: "1.000001",
        actionId: "opensesame_approve",
        teamId: "T_TEST",
        userId: "U_TEST",
        timestamp: TIMESTAMP,
      }),
    ).rejects.toThrow(/no such decision button/);
    standIn.reset();
    expect(standIn.messages).toHaveLength(0);
    expect(standIn.requests).toHaveLength(0);
    await standIn.close();
    await expect(
      standIn.fetchImpl(`${standIn.apiBaseUrl}/chat.postMessage`),
    ).rejects.toThrow(/closed/);
    await other.close();
  });

  it("does not retain a request or issue a callback across reset", async () => {
    const { standIn, adapter } = setup();
    await adapter.deliver(adapter.render(INPUT), DESTINATION);
    const callback = standIn.signedInteraction({
      channel: "U_TEST",
      ts: "1.000001",
      actionId: "opensesame_approve",
      teamId: "T_TEST",
      userId: "U_TEST",
      timestamp: TIMESTAMP,
    });
    const pendingRequest = standIn.fetchImpl(
      `${standIn.apiBaseUrl}/chat.postMessage`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    const rejectedCallback = expect(callback).rejects.toThrow(/reset/);
    const rejectedRequest = expect(pendingRequest).rejects.toThrow(/reset/);
    standIn.reset();
    await Promise.all([rejectedCallback, rejectedRequest]);
    expect(standIn.messages).toHaveLength(0);
    expect(standIn.requests).toHaveLength(0);
    await standIn.close();
  });

  it.each(["reset", "close"] as const)(
    "%s promptly rejects and cancels a stalled streamed body",
    async (operation) => {
      const { standIn } = setup();
      let streamCancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          streamCancelled = true;
          // A producer is not obliged to settle its own cancellation promptly.
          return new Promise<void>(() => {});
        },
      });
      const init = {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      };
      const pending = standIn.fetchImpl(
        `${standIn.apiBaseUrl}/chat.postMessage`,
        init,
      );
      const rejected = expect(pending).rejects.toThrow(
        operation === "reset" ? /reset/ : /closed/,
      );
      if (operation === "reset") standIn.reset();
      else await standIn.close();
      await rejected;
      await vi.waitFor(() => expect(streamCancelled).toBe(true));
      expect(standIn.requests).toHaveLength(0);
      if (operation === "reset") await standIn.close();
    },
  );

  it("honors an abort while reading a streamed body", async () => {
    const { standIn } = setup();
    const controller = new AbortController();
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        streamCancelled = true;
      },
    });
    const init = {
      method: "POST",
      body,
      duplex: "half",
      signal: controller.signal,
    };
    const pending = standIn.fetchImpl(
      `${standIn.apiBaseUrl}/chat.postMessage`,
      init,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(streamCancelled).toBe(true));
    expect(standIn.requests).toHaveLength(0);
    await standIn.close();
  });
});
