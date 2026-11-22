/**
 * The tour of each optional section's place in the rail (ADR 0163).
 *
 * Access, Activity, Connections, Identity and Wallet are drawn only while the
 * capability that owns them is in the plan, so each tour is contributed by that
 * capability, with the `nav.<section>` target it points at, and is offered
 * exactly while the row is. They are for a wide screen, where the rail is; on a
 * narrow one the sections are in the drawer that `shell.sections.phone` shows.
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const NAV_ACCESS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections.access",
    title: "Find Access",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections.access"',
      'say "Access is where you decide what an agent or an application may do for you."',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "nav.access" "Select Access to review grants, requests and active sessions." side=right',
      "end",
    ].join("\n"),
  },
];

export const NAV_ACTIVITY_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections.activity",
    title: "Find Activity",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections.activity"',
      'say "Activity is the log of what happened on this device: vault, settings, access and request events."',
      'navigate "/activity"',
      'wait route "/activity" timeout=15000',
      'focus "nav.activity" "Select Activity to review the log. Use the row at the top to return to the vault." side=right',
      "end",
    ].join("\n"),
  },
];

export const NAV_CONNECTIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections.connections",
    title: "Find Connections",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections.connections"',
      'say "Connections link this vault to the services an agent or a person works with."',
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "nav.connections" "Select Connections to add, test or revoke provider connections." side=right',
      "end",
    ].join("\n"),
  },
];

export const NAV_IDENTITY_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections.identity",
    title: "Find Identity",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections.identity"',
      'say "Identity is how people and applications are known to this device."',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "nav.identity" "Select Identity to manage accounts, providers and linked identities." side=right',
      "end",
    ].join("\n"),
  },
];

export const NAV_WALLET_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections.wallet",
    title: "Find Wallet",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections.wallet"',
      'say "The Wallet holds budgets, payment methods and spending passes."',
      'navigate "/wallet"',
      'wait route "/wallet" timeout=15000',
      'focus "nav.wallet" "Select Wallet to review spending, budgets, passes and payment methods." side=right',
      "end",
    ].join("\n"),
  },
];
