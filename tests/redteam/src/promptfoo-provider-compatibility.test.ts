/** Exercise the actual promptfoo provider and its nested AI SDK without network access. */
import { afterAll, beforeAll, expect, test, vi } from "vitest";

type Promptfoo = typeof import("promptfoo");
let promptfoo: Promptfoo;
type RequestBody = { responseFormat?: { type?: string }; values?: unknown };
const requests: Array<{ url: string; headers: Headers; body: RequestBody }> =
  [];
const usage = {
  inputTokens: { total: 4, noCache: 4 },
  outputTokens: { total: 2, text: 2 },
};

beforeAll(async () => {
  vi.stubEnv("PROMPTFOO_DISABLE_TELEMETRY", "1");
  vi.stubEnv("IS_TESTING", "true");
  vi.stubGlobal("fetch", async (request: string, init: RequestInit = {}) => {
    const url = String(request);
    if (
      !/^https:\/\/gateway\.invalid\/(language-model|embedding-model)$/.test(
        url,
      )
    ) {
      throw new Error(`Unexpected request: ${url}`);
    }
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    // SAFETY: The SDK serializes this test-controlled provider call as JSON.
    const body = JSON.parse(String(init.body)) as RequestBody;
    requests.push({ url, headers, body });
    if (headers.get("ai-language-model-id") === "test/error") {
      return Response.json(
        { error: { message: "fixture denied" } },
        { status: 401 },
      );
    }
    if (url.endsWith("/embedding-model")) {
      return Response.json({
        embeddings: [[0.1, 0.2]],
        usage: { tokens: 3 },
      });
    }
    if (headers.get("ai-language-model-streaming") === "true") {
      const events = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "safe " },
        { type: "text-delta", id: "1", delta: "response" },
        { type: "text-end", id: "1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage,
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
          "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    const text =
      body.responseFormat?.type === "json"
        ? '{"decision":"safe"}'
        : "safe response";
    return Response.json({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    });
  });
  promptfoo = await import("promptfoo");
  promptfoo.cache.disableCache();
});

afterAll(() => {
  promptfoo?.cache.enableCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type FixtureConfig = {
  streaming?: boolean;
  maxRetries?: number;
  responseSchema?: {
    type: "object";
    properties: { decision: { type: "string" } };
    required: string[];
  };
};

async function provider<T extends FixtureConfig>(id: string, config?: T) {
  return promptfoo.loadApiProvider(id, {
    options: {
      config: {
        apiKey: "local-test-key",
        baseUrl: "https://gateway.invalid",
        ...config,
      },
    },
  });
}

test("promptfoo's AI SDK provider handles text, structured output, streaming, embeddings and rejection", async () => {
  const text = await (await provider("vercel:test/model")).callApi(
    "example prompt",
  );
  expect(text).toMatchObject({
    output: "safe response",
    finishReason: "stop",
    tokenUsage: { total: 6 },
  });
  expect(requests[0]?.headers.get("ai-language-model-id")).toBe("test/model");

  const structured = await (
    await provider("vercel:test/model", {
      responseSchema: {
        type: "object",
        properties: { decision: { type: "string" } },
        required: ["decision"],
      },
    })
  ).callApi("structured prompt");
  expect(structured.output).toEqual({ decision: "safe" });

  const stream = await (
    await provider("vercel:test/model", { streaming: true })
  ).callApi("stream prompt");
  expect(stream.output).toBe("safe response");
  expect(requests[2]?.headers.get("ai-language-model-streaming")).toBe("true");

  const embeddings = await provider("vercel:embedding:test/model");
  expect(embeddings.callEmbeddingApi).toBeDefined();
  const embedding = await embeddings.callEmbeddingApi?.("embedding input");
  expect(embedding?.embedding).toEqual([0.1, 0.2]);
  expect(requests[3]?.body.values).toEqual(["embedding input"]);

  const denied = await (
    await provider("vercel:test/error", { maxRetries: 0 })
  ).callApi("denied prompt");
  expect(denied.error).toMatch(/API call error/);
  expect(requests).toHaveLength(5);
});
