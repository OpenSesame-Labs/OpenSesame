/** @vitest-environment jsdom */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { stageBoundRevocation } from "./identity-revocation-journal.js";
import { queueBoundRevocation } from "./identity-revocation-journal-queue.js";
import { settleIdentityRevocations } from "./identity-revocation-queue.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

it("keeps the pending proof when Identity redirects a revocation to another origin", async () => {
  localStorage.clear();
  sessionStorage.clear();
  let received = 0;
  const other = createServer((_request, response) => {
    received += 1;
    response.writeHead(204).end();
  });
  const otherOrigin = await listen(other);
  const identity = createServer((_request, response) => {
    response.writeHead(307, { location: `${otherOrigin}/capture` }).end();
  });
  const issuer = await listen(identity);
  const originalEligible = localNetworkFetchSeams.eligible;
  try {
    localNetworkFetchSeams.eligible = () => true;
    configureHost(
      createTestHost({
        env: { VITE_IDENTITY_API: issuer },
        locks: webLocksDouble(),
      }),
    );
    const entry = stageBoundRevocation(
      {
        issuerOrigin: issuer,
        principalId: "previous",
        sessionId: "ps_previous",
        proof: "a".repeat(64),
      },
      false,
    );
    queueBoundRevocation(
      entry,
      () => issuer,
      async () => {},
    );
    await expect(settleIdentityRevocations()).rejects.toThrow(
      /sign-out did not finish/i,
    );
    expect(received).toBe(0);
    expect(localStorage.getItem(entry.key)).not.toBeNull();
  } finally {
    localNetworkFetchSeams.eligible = originalEligible;
    localStorage.clear();
    sessionStorage.clear();
    configureHost(createTestHost());
    identity.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => identity.close(() => resolve())),
      new Promise<void>((resolve) => other.close(() => resolve())),
    ]);
  }
});
