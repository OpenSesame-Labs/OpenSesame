import { cliAppIntegrationPolicyDocument } from "@opensesame/app-core/lib/cli-app-integration/policy.js";
import { afterEach, expect, it, vi } from "vitest";
import { createCliAppIntegrationPort } from "./cli-app-integration-client.js";
import { humanRevealAppIntegrationRefusal } from "./reveal-gate.js";

vi.mock("./daemon-pin.js", () => ({
  verifyLocalDaemonForCliAppIntegration: async () => true,
}));

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
  const port = createCliAppIntegrationPort();
  for (const verb of [
    "read",
    "reveal",
    "env-resolve",
    "run",
    "pass-reveal",
    "unknown",
  ]) {
    const outcome = await Reflect.apply(port.ensureReveal, port, [
      { verb, terminalSessionId: "term-test" },
    ]);
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
