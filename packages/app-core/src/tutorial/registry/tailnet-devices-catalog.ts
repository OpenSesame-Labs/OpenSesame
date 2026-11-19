/**
 * Targets, the walkthrough and the help `networking.tailnet-devices`
 * contributes (ADR 0169): the tailnet's machines under Identity › Devices,
 * live only while that capability is in the plan.
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const TAILNET_DEVICES_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "identity.tailnet-devices",
    description:
      "Review tailnet devices through a paired daemon. Approve devices, change settings, expire keys or remove devices.",
    role: "surface",
    routes: ["/identity"],
    capabilityId: "tailnet.devices.manage",
  },
  {
    id: "identity.tailnet-devices.add",
    description:
      "Create a Tailscale authentication key with the selected options. Copy the key and command when shown.",
    role: "action",
    routes: ["/identity"],
    capabilityId: "tailnet.keys.manage",
  },
];

export const TAILNET_DEVICES_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "identity.tailnet.devices.manage",
    title: "Manage the tailnet's devices",
    routes: ["/identity"],
    guide: [
      "guide/1",
      'goal "identity.tailnet.devices.manage"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.devices" "Pair the daemon with opensesame daemon tailnet pair and this page\'s address, then open the link it prints. The daemon manages tailnet changes." side=bottom',
      'wait target "identity.tailnet-devices" event=appear timeout=60000',
      'focus "identity.tailnet-devices" "Review devices here. You can approve a device, change its settings, expire its key or remove it. Changes appear in Activity." side=top',
      'focus "identity.tailnet-devices.add" "Select Add a device to create an auth key. Copy the key and command when shown; they are displayed only once." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const TAILNET_DEVICES_HELP: readonly HelpTopic[] = [
  {
    id: "help.tailnet-devices",
    title: "How do I approve, rename or add a device on my tailnet?",
    answer:
      "Run opensesame daemon tailnet connect on a machine in your tailnet with a Tailscale OAuth client or API token. Run opensesame daemon tailnet pair --origin with this page's address, then open the printed link. Manage devices under Identity → Devices, or select Add a device to create an auth key.",
    routes: [],
    goal: "identity.tailnet.devices.manage",
    keywords: [
      "tailscale",
      "tailnet",
      "device",
      "machine",
      "approve",
      "auth key",
      "exit node",
      "subnet",
    ],
  },
];
