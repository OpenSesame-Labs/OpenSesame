import { expect, vi } from "vitest";
import type { AppContext } from "../context.js";

/** Stub only the Host withdrawal endpoint; other network traffic stays real. */
export function mockHostWithdrawal(ctx: AppContext) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const requests: unknown[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      if (String(url).startsWith(ctx.config.hostApiUrl)) {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return realFetch(url, init);
    });
  return { requests, restore: () => spy.mockRestore() };
}

export function expectHostWithdrawals(
  requests: unknown[],
  organizationId: string,
  principalId: string,
): void {
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request).toMatchObject({
      organization_id: organizationId,
      principal_id: principalId,
      membership_incarnation: expect.any(String),
      authority_revision: expect.any(String),
      withdrawal_id: expect.any(String),
    });
  }
}
