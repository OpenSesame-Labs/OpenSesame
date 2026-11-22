/** The exact object-generation subset used by the browser Prompt API adapter. */
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod/mini";

type BrowserModel = Pick<
  LanguageModelV2,
  "specificationVersion" | "provider" | "modelId" | "doGenerate"
>;

type BrowserGenerateOptions = {
  model: BrowserModel;
  schema: Parameters<typeof z.safeParse>[0];
  prompt: string;
  abortSignal?: AbortSignal;
};

class BrowserNoObjectGeneratedError extends Error {
  override readonly name = "AI_NoObjectGeneratedError";
}

function noObject(reason: string): never {
  throw new BrowserNoObjectGeneratedError(`No object generated: ${reason}.`);
}

export async function generateObject(options: BrowserGenerateOptions) {
  const model = options.model;
  // Retain the SDK's observable model metadata reads and method receiver.
  const specificationVersion = model.specificationVersion;
  const provider = model.provider;
  const modelId = model.modelId;
  void provider;
  if (specificationVersion !== "v2")
    throw new Error(
      "The browser language model must implement specification v2.",
    );
  const request: Parameters<BrowserModel["doGenerate"]>[0] = {
    responseFormat: { type: "json" },
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: options.prompt }],
      },
    ],
  };
  if (options.abortSignal !== undefined)
    request.abortSignal = options.abortSignal;
  const generated = await model.doGenerate.call(model, request);
  const text = generated.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    noObject("could not parse the response");
  }
  const parsed = z.safeParse(options.schema, value);
  if (!parsed.success) noObject("response did not match schema");
  return {
    object: parsed.data,
    finishReason: generated.finishReason,
    usage: generated.usage,
    warnings: generated.warnings,
    providerMetadata: generated.providerMetadata,
    response: generated.response ?? { modelId },
    request: {},
    reasoning: undefined,
  };
}
