import { randomUUID } from "node:crypto";
import type { OrganizationRole } from "@opensesame/os-domain";
import { expect, vi } from "vitest";
import { z } from "zod";
import type { AppContext } from "../context.js";

const withdrawalRequest = z.object({
  organization_id: z.string(),
  principal_id: z.string(),
  membership_incarnation: z.string().uuid(),
  authority_revision: z.string().uuid(),
  withdrawal_id: z.string().uuid(),
});
type WithdrawalRequest = z.infer<typeof withdrawalRequest>;

/** Stub only the Host withdrawal endpoint; other network traffic stays real. */
export function mockHostWithdrawal(ctx: AppContext) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const requests: WithdrawalRequest[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      if (String(url).startsWith(ctx.config.hostApiUrl)) {
        requests.push(withdrawalRequest.parse(JSON.parse(String(init?.body))));
        return new Response(null, { status: 204 });
      }
      return realFetch(url, init);
    });
  return { requests, restore: () => spy.mockRestore() };
}

export function expectHostWithdrawals(
  requests: readonly WithdrawalRequest[],
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

/**
 * Finish a role withdrawal directly in the membership store, so a test can
 * advance the membership authority without a Host round trip.
 */
export async function changeRoleInStore(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
  role: OrganizationRole,
): Promise<void> {
  const store = ctx.stores.organizationMemberships;
  const membership = await store.findVersioned(organizationId, principalId);
  if (!membership) throw new Error("Missing membership");
  const withdrawalId = randomUUID();
  expect(
    await store.beginWithdrawal(
      organizationId,
      principalId,
      membership.incarnation,
      membership.authorityRevision,
      {
        id: withdrawalId,
        kind: "change_role",
        role,
        actorType: "system",
        actorPrincipalId: principalId,
        correlationId: "test-role-change",
      },
    ),
  ).toBe(true);
  expect(
    await store.completeRoleWithdrawal(
      organizationId,
      principalId,
      membership.incarnation,
      withdrawalId,
      role,
      new Date(),
    ),
  ).toBeDefined();
}
