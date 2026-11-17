import { MemoryRepositories } from "@opensesame/database";
import { createTestChannelAdapter } from "@opensesame/identity-worker/testkit";
import type { OutboxEvent } from "@opensesame/os-domain";
import { withTestResources } from "@opensesame/testing";
import { expect, it } from "vitest";
import {
  createRoutePlanStore,
  deliverNotifications,
  registryFromAdapters,
  routeNotification,
} from "../notifications.js";
import { nextAttemptDelayMs } from "../webhooks.js";

it("chaos: a routed notification is retried after a temporary failure and succeeds", async () => {
  await withTestResources(async (scope) => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    let clock = now;
    const channel = scope.use(
      createTestChannelAdapter("slack", {
        deliveryScript: [
          { ok: false, retryable: true, error: "status 503" },
          { ok: true, providerMessageRef: "ref_after_retry" },
        ],
      }),
    );
    const repos = new MemoryRepositories();
    await repos.channelBindings.create({
      id: "chb_slack",
      principalId: "prn_approver",
      kind: "slack",
      providerId: "slack",
      providerTenantId: "tenant_slack",
      providerSubjectId: "subject_slack",
      state: "active",
      verification: "provider_oauth_install",
      createdAt: now,
      metadata: {},
      version: 1,
    });
    await repos.notificationPreferences.upsert({
      principalId: "prn_approver",
      byClass: {
        authorization_request: { channels: ["slack"], fanOut: false },
      },
      updatedAt: now,
      version: 1,
    });
    const event: OutboxEvent = {
      id: "obx_1",
      aggregateType: "authorization_request",
      aggregateId: "areq_1",
      eventType: "authority.invocation.requested",
      payload: {
        principalId: "prn_approver",
        authReqId: "areq_1",
        requestDigest: "sha256:abc",
      },
      createdAt: now,
      availableAt: now,
      attempts: 0,
    };
    const deps = {
      repos,
      clock: () => clock,
      adapters: registryFromAdapters([channel]),
      plans: createRoutePlanStore(),
    };

    expect(await routeNotification(deps, event)).toMatchObject({ enqueued: 1 });
    expect(await deliverNotifications(deps)).toMatchObject({ failed: 1 });
    expect(await deliverNotifications(deps)).toMatchObject({ delivered: 0 });
    expect(channel.sent).toHaveLength(1);
    clock = new Date(now.getTime() + nextAttemptDelayMs(1) + 1);
    expect(await deliverNotifications(deps)).toMatchObject({ delivered: 1 });
    expect(
      (await repos.notificationDeliveries.listForRequest("areq_1"))[0],
    ).toMatchObject({
      state: "delivered",
      attempts: 2,
      providerMessageRef: "ref_after_retry",
    });
    expect(channel.sent).toHaveLength(2);
  });
});
