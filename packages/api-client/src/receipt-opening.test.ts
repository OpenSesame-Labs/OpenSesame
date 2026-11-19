import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";
import { verifyReceiptIntentOpening } from "./receipt-opening.js";

const commitment =
  "sha256:74496e4d5230a7dfebaaa61412cc8b9a98bced0f7b7135669916ca9bfd91406b";
const digest = `sha256:${"b".repeat(64)}`;
const opening = `hmac-sha256:v1:${"a".repeat(64)}`;

describe("receipt intent opening", () => {
  it("checks the cross-language known-answer vector", async () => {
    await expect(
      verifyReceiptIntentOpening(commitment, digest, opening),
    ).resolves.toBe(true);
  });

  it("rejects changed or malformed inputs", async () => {
    await expect(
      verifyReceiptIntentOpening(
        commitment,
        `sha256:${"c".repeat(64)}`,
        opening,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyReceiptIntentOpening(
        commitment,
        digest,
        `hmac-sha256:v1:${"f".repeat(64)}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyReceiptIntentOpening(commitment, digest, "hmac-sha256:v1:short"),
    ).resolves.toBe(false);
  });

  it("is available through the public API client", async () => {
    const client = createApiClient({ baseUrl: "http://127.0.0.1:8787" });
    await expect(
      client.verifyReceiptIntentOpening(commitment, digest, opening),
    ).resolves.toBe(true);
  });
});
