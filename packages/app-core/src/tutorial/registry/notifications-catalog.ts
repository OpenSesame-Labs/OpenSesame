/**
 * Targets, routes and the walkthrough the `notifications.routing` capability
 * contributes (ADR 0084; ADR 0140 D9): Settings › Notifications, live only
 * while the capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goals.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const NOTIFICATIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.notifications",
    description:
      "Choose notification channels and destinations for each request type. Approval requirements stay the same.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "identity.notification.preferences.manage",
  },
];

/**
 * What the `notifications.local` capability contributes (ADR 0162): its panel
 * inside Settings › Features, live only while the capability is in the
 * plan. A walkthrough of a doorbell on this device, with no service in it.
 */
export const LOCAL_NOTIFICATIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.local-notifications",
    description:
      "Allow system notifications or show a request count in the browser tab. Browser permission is requested when you select it.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "identity.notification.local.manage",
  },
];

export const LOCAL_NOTIFICATIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.local-notifications",
    title: "Choose how this device tells you a request is waiting",
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.local-notifications"',
      'say "Requests appear on the bell. You can also show them in the tab title or allow system notifications. Notifications do not approve requests."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/features"',
      'wait route "/settings/features" timeout=15000',
      'scroll "feature.local-notifications"',
      'focus "feature.local-notifications" "Enable Local notifications to show requests on this device." side=bottom',
      'navigate "/settings/features/local-notifications"',
      'wait route "/settings/features/local-notifications" timeout=15000',
      'focus "settings.local-notifications" "Enable system notifications to request browser permission. The bell and Requests list show pending requests." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const NOTIFICATIONS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/notifications",
    title: "Settings — notifications: channels, destinations and their order",
  },
];

export const NOTIFICATIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.notifications",
    title: "Choose where you hear about requests",
    // Offered on Settings only: a walkthrough of a settings page.
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.notifications"',
      'say "Notification preferences do not change approval requirements or override channels disabled by your administrator."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/notifications"',
      'wait route "/settings/notifications" timeout=15000',
      'focus "settings.notifications" "For each request type, order the available channels or connect a destination." side=bottom',
      "end",
    ].join("\n"),
  },
];
