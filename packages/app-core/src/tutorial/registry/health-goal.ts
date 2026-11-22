import type { GuideGoalDescriptor } from "./goal-types.js";

export const HEALTH_REVIEW_GOAL = {
  id: "vault.health.review",
  title: "Review password health",
  routes: [],
  capabilities: ["vault.security-checks"],
  guide: [
    "guide/1",
    'goal "vault.health.review"',
    'say "Password health is checked on this device."',
    'navigate "/vault/health"',
    'wait route "/vault/health" timeout=15000',
    'annotate "vault.health.summary" "Review how many passwords were checked and how many are weak, reused or aging." side=bottom',
    'focus "vault.health.findings" "Review each finding and open the item to update its password." side=top',
    "end",
  ].join("\n"),
} satisfies GuideGoalDescriptor;
