import { createTestChannelAdapter } from "@opensesame/identity-worker/testkit";
import type { NotificationDelivery } from "@opensesame/os-domain";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const now = new Date("2026-11-17T00:00:00Z");
const delivery: NotificationDelivery = {
  id: "delivery-1",
  principalId: "person-1",
  kind: "slack",
  notificationClass: "authorization_request",
  eventType: "authority.invocation.requested",
  outboxEventId: "outbox-1",
  payload: {},
  confidentiality: "minimal",
  state: "pending",
  attempts: 0,
  nextAttemptAt: now,
  createdAt: now,
};

describe("test channel adapter", () => {
  it("keeps minimal renderings free of the input payload", () => {
    const channel = createTestChannelAdapter("slack");
    const input = {
      eventType: "authority.invocation.requested",
      notificationClass: "authorization_request" as const,
      confidentiality: "minimal" as const,
      payload: { secret: "must-not-be-rendered" },
    };
    expect(channel.render(input)).toEqual({
      eventType: "authority.invocation.requested",
      confidentiality: "minimal",
    });
    input.payload.secret = "changed";
    expect(channel.rendered[0]?.payload.secret).toBe("must-not-be-rendered");
  });

  it.each(["descriptive", "full"] as const)(
    "does not copy arbitrary payload fields into a %s rendering",
    (confidentiality) => {
      const channel = createTestChannelAdapter("slack");
      const result = channel.render({
        eventType: "authority.invocation.requested",
        notificationClass: "authorization_request",
        confidentiality,
        payload: {
          eventType: "fake-event",
          confidentiality: "fake-level",
          requesterLabel: "private-requester",
          authorizationDetails: [{ account: "private-account" }],
          access_token: "private-token",
        },
      });
      expect(result).toEqual({
        eventType: "authority.invocation.requested",
        confidentiality,
      });
      expect(JSON.stringify(result)).not.toContain("private-");
    },
  );

  it("scripts failures and successes, refuses exhaustion, and rewinds on reset", async () => {
    const channel = createTestChannelAdapter("slack", {
      deliveryScript: [
        new Error("offline"),
        { ok: true, providerMessageRef: "sent" },
      ],
    });
    const input = { delivery, now };
    await expect(channel.deliver(input)).rejects.toThrow("offline");
    await expect(channel.deliver(input)).resolves.toEqual({
      ok: true,
      providerMessageRef: "sent",
    });
    await expect(channel.deliver(input)).rejects.toThrow(/script exhausted/);
    expect(channel.sent).toHaveLength(3);
    channel.reset();
    expect(channel.sent).toHaveLength(0);
    await expect(channel.deliver(input)).rejects.toThrow("offline");
  });

  it("isolates instances and closes without leaving test data behind", async () => {
    const first = createTestChannelAdapter("slack");
    const second = createTestChannelAdapter("slack");
    await withTestResources(async (scope) => {
      scope.use(first);
      await first.deliver({ delivery, now });
      expect(second.sent).toHaveLength(0);
    });
    await first.close();
    expect(first.sent).toHaveLength(0);
    await expect(first.deliver({ delivery, now })).rejects.toThrow(/closed/);
    expect(() => first.reset()).toThrow(/closed/);
    await expect(second.deliver({ delivery, now })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not report a successful send when unconfigured", async () => {
    const channel = createTestChannelAdapter("slack", { configured: false });
    expect(channel.isConfigured()).toBe(false);
    await expect(channel.deliver({ delivery, now })).resolves.toEqual({
      ok: false,
      retryable: false,
      error: "unconfigured",
    });
  });
});
