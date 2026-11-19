import { cliAppIntegrationPolicyDocument } from "@opensesame/app-core/lib/cli-app-integration/policy.js";
import { afterEach, expect, it, vi } from "vitest";
import { createCliAppIntegrationPort } from "./cli-app-integration-client.js";
import { humanRevealAppIntegrationRefusal } from "./reveal-gate.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("does not contact an old daemon that would approve any verb", async () => {
  vi.stubEnv("OPENSESAME_DAEMON_API", "http://127.0.0.1:18790");
  const oldDaemon = vi.fn(
    async () => new Response('{"status":"approved"}', { status: 200 }),
  );
  vi.stubGlobal("fetch", oldDaemon);
  const port = createCliAppIntegrationPort({
    verifyLocalDaemon: async () => true,
  });
  for (const verb of [
    "read",
    "reveal",
    "env-resolve",
    "run",
    "pass-reveal",
  ] as const) {
    // Exercise untyped callers as well as the declared CLI verbs.
    const input: unknown = { verb, terminalSessionId: "term-test" };
    const outcome = await port.ensureReveal(
      input as Parameters<typeof port.ensureReveal>[0],
    );
    expect(outcome).toBe("blockedApproval");
  }
  expect(oldDaemon).not.toHaveBeenCalled();
});

it("does not trust an injected port that says approved", async () => {
  const approve = vi.fn(async () => "approve" as const);
  const request = {
    verb: "run" as const,
    reveal: true,
    desktop: true,
    appIntegration: { ensureReveal: approve },
    terminalSessionId: "term-test",
  };
  expect(await humanRevealAppIntegrationRefusal(request)).toBe(
    cliAppIntegrationPolicyDocument.messages.blockedApproval,
  );
  expect(approve).not.toHaveBeenCalled();
});
