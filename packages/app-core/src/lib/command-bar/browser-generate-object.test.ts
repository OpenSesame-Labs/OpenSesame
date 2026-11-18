import type { LanguageModelV2 } from "@ai-sdk/provider";
import { generateObject as sdkGenerateObject } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateObject as browserGenerateObject } from "./browser-generate-object.js";

const schema = z.strictObject({ action: z.literal("help") });

function fixture(text: string, failure?: Error) {
  const calls: unknown[] = [];
  const reads: string[] = [];
  const model: LanguageModelV2 = {
    get specificationVersion() {
      reads.push("specificationVersion");
      return "v2" as const;
    },
    get provider() {
      reads.push("provider");
      return "opensesame.fixture";
    },
    get modelId() {
      reads.push("modelId");
      return "browser-fixture";
    },
    supportedUrls: {},
    async doGenerate(options) {
      expect(this).toBe(model);
      calls.push(options);
      if (failure) throw failure;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not used");
    },
  };
  return { calls, model, reads };
}

type RejectionOutcome = { readonly object: { readonly action: "help" } };

async function rejection(promise: Promise<RejectionOutcome>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected rejection");
}

type FixtureOptions = {
  model: LanguageModelV2;
  schema: typeof schema;
  prompt: string;
  maxRetries: 0;
  abortSignal?: AbortSignal;
};

const generators = [
  (options: FixtureOptions) => sdkGenerateObject(options),
  (options: FixtureOptions) => browserGenerateObject(options),
];

describe("the production Prompt API generateObject boundary", () => {
  it("matches successful object validation and required model metadata", async () => {
    const traces: string[][] = [];
    for (const generate of generators) {
      const { calls, model, reads } = fixture('{"action":"help"}');
      const result = await generate({
        model,
        schema,
        prompt: "Return command help",
        maxRetries: 0,
      });
      expect(result.object).toEqual({ action: "help" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "Return command help" }],
          },
        ],
      });
      traces.push(reads);
    }
    expect(new Set(traces[1])).toEqual(new Set(traces[0]));
    expect(traces[1]).toEqual(["specificationVersion", "provider", "modelId"]);
  });

  it.each([
    "not JSON",
    '{"action":"unknown"}',
    '{"action":"help","unexpected":true}',
  ])("matches the SDK refusal for %s", async (text) => {
    const errors: Error[] = [];
    for (const generate of generators) {
      const { model } = fixture(text);
      errors.push(
        await rejection(
          generate({
            model,
            schema,
            prompt: "Return command help",
            maxRetries: 0,
          }),
        ),
      );
    }
    expect(errors[1]?.name).toBe(errors[0]?.name);
    expect(errors[1]?.message).toBe(errors[0]?.message);
  });

  it("preserves provider failure identity and the original abort signal", async () => {
    const failure = new Error("Prompt provider failed");
    const controller = new AbortController();
    for (const generate of generators) {
      const { calls, model } = fixture("", failure);
      await expect(
        generate({
          model,
          schema,
          prompt: "Return command help",
          abortSignal: controller.signal,
          maxRetries: 0,
        }),
      ).rejects.toBe(failure);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ abortSignal: controller.signal });
    }
  });
});
