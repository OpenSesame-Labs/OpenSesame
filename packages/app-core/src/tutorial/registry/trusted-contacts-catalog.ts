/**
 * Targets and the walkthrough `sharing.trusted-contacts` contributes
 * (ADR 0187): the Trusted contacts section of Settings › Security and its
 * Circles panel, live only while that capability is in the plan.
 *
 * The panels hold lists, and a list holds only what a person's own ceremonies
 * made; a target here names a panel or the category, never a circle, a contact
 * or a request (ADR 0088). The ceremonies' own keys append their targets and
 * steps beside these as their sheets land.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const TRUSTED_CONTACTS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/security",
    title: "Settings — security: trusted contacts and circles",
  },
];

export const TRUSTED_CONTACTS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.trusted-contacts",
    description: "Manage trusted contact circles on this device.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
  },
  {
    id: "settings.trusted-contacts-circles",
    description: "Review each circle’s approval rule, contacts and status.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
  },
  {
    id: "circle.new",
    description:
      "Create a circle, set its approval rule and timing, and invite trusted contacts.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
  },
];

export const TRUSTED_CONTACTS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.trusted-contacts.circle",
    title: "Start a circle of trusted contacts",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.circle"',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.trusted-contacts" "A circle lets trusted contacts approve requests. You exchange packets directly, and a delay gives you time to object." side=bottom',
      'focus "settings.trusted-contacts-circles" "This list shows your circles, their approval rules, contacts and status." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.trusted-contacts.owner",
    title: "Make a circle and invite its contacts",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.owner"',
      'say "Create a circle, invite trusted contacts and choose how many approvals are required."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.trusted-contacts-circles" "Open a circle to manage contacts, request approval or retire it." side=top',
      'focus "circle.new" "Select Start a circle. Name it, set its approval rule and timing, then send each contact an invitation." side=bottom',
      'success "Exchange the packets directly with your contacts."',
      "end",
    ].join("\n"),
  },
];
