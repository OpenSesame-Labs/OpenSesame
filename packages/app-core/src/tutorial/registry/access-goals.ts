/**
 * Goals and authored help the `access.authority` capability contributes,
 * alongside `authority-help.ts` (the Host-authority topics and their goals).
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const ACCESS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "access.grant",
    title: "Grant an agent access",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.grant"',
      'say "A grant lets a person or agent use a resource under a policy without seeing its credential."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access/shares"',
      'wait route "/access/shares" timeout=15000',
      'focus "access.grant-access" "Select Grant access, then choose the recipient, resource, policy and duration." side=bottom',
      'wait target "access.grant-ceremony" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "access.relay",
    title: "Create and review access requests",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.relay"',
      'say "Enter the approver address and requested action. Review the request and complete any required verification."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.requests" "Create, approve or deny on Requests. Each request is its own decision; nothing is auto-approved." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.sessions.review",
    title: "Review running agent tasks",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.sessions.review"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.sessions" "Start a task with an action, resource and deadline. Review or end running tasks here." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.connectors",
    title: "Bind a connector to a person or agent",
    routes: ["/access"],
    guide: [
      "guide/1",
      'goal "access.connectors"',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'say "Configure connections on the Connections page, then choose who may use them and for how long."',
      'focus "access.connectors" "Select Add to grant connector access. Open a grant to revoke it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.review",
    title: "Review grants, resources and policies",
    routes: ["/access"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "access.review"',
      'say "Review what is shared, the available resources and application policies."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.grants" "Review existing grants and their expiration dates. Revocation requires confirmation." side=bottom',
      'focus "access.resources" "Review the resources that can be shared and their current access." side=bottom',
      'focus "access.policies" "Open an application policy to review its callback addresses and allowed roles. Unchecked roles are denied." side=bottom',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'success "Use these sections to review access before making changes."',
      "end",
    ].join("\n"),
  },
  {
    id: "access.requests.hosted",
    title: "Review requests sent to your account",
    routes: ["/access"],
    libraryOnly: true,
    // The panel is drawn only where an Identity API address is set.
    requires: ["signin-service.configured"],
    guide: [
      "guide/1",
      'goal "access.requests.hosted"',
      'say "Requests sent to your account appear alongside local requests."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access/requests"',
      'wait route "/access/requests" timeout=15000',
      'focus "access.relay" "Open a request to review its permissions and decide whether to approve it. Select Reload to check for new requests." side=bottom',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'success "Report requests you do not recognize instead of approving them."',
      "end",
    ].join("\n"),
  },
];

export const ACCESS_HELP: readonly HelpTopic[] = [
  {
    id: "help.access.grant",
    title: "How do I give an agent access to something?",
    answer:
      "Open Access, select Grants, then select Add in Identity shares. Choose the recipient, resource, policy and duration. The recipient can use the resource without seeing its credential.",
    routes: [],
    goal: "access.grant",
    keywords: [
      "agent",
      "access",
      "grant",
      "delegate",
      "delegation",
      "share",
      "permission",
      "claim code",
      "scope",
      "allow",
      "authority",
      "token",
    ],
  },
];
