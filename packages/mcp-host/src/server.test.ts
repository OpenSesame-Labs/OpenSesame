import { afterEach, describe, expect, it } from "vitest";

/**
 * server.ts is the stdio entrypoint: it builds the McpServer, wraps it with
 * telemetry (a no-op without OPENSESAME_TELEMETRY_KEY), registers the host
 * tools, and connects a stdio transport. Importing the module executes all of
 * that; a boot failure (bad registration, transport error) rejects the import.
 */
describe("mcp-host entrypoint", () => {
  const savedKey = process.env.OPENSESAME_TELEMETRY_KEY;

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.OPENSESAME_TELEMETRY_KEY;
    } else {
      process.env.OPENSESAME_TELEMETRY_KEY = savedKey;
    }
  });

  it("boots: registers tools and connects stdio without throwing", async () => {
    delete process.env.OPENSESAME_TELEMETRY_KEY;
    await expect(import("./server.js")).resolves.toBeDefined();
  }, 15_000);
});
