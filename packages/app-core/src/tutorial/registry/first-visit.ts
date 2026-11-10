/**
 * Which walkthrough a screen offers the first time somebody meets it
 * (ADR 0221).
 *
 * The library (`areas.ts`) answers "what can I learn"; this answers "what
 * should a person who has just arrived here be shown". The order is authored:
 * each route names the tours that introduce it, most useful first, and after
 * those come the tours written for that route that no list names. The first
 * one the shared gate offers (`goalOffered`) that this device has not answered
 * yet is the offer. A screen with every candidate answered offers nothing, so
 * an offer is made at most once per tour, ever.
 *
 * A route with no entry of its own inherits its parent's
 * (`/settings/features/networking` → `/settings/features` → `/settings`).
 * `first-visit.test.ts` fails a route that resolves to nothing and a tour no
 * route offers, so neither a screen nor a walkthrough can be added without a
 * first visit that reaches it.
 */

import type { GuideGoalId } from "@opensesame/guide-lang";
import {
  type LibraryOptions,
  TUTORIAL_AREAS,
  type Tutorial,
  goalOffered,
  tutorialStartsFrom,
  tutorialStepCount,
} from "./areas.js";
import {
  type GuideGoalDescriptor,
  guideGoal,
  mergedGuideGoals,
} from "./goals.js";
import type { GuideRouteId } from "./routes.js";

export const FIRST_VISIT_TOURS = {
  // The gates. A gate offers only tours written for it (ADR 0166); `/unlock`
  // and `/setup` are parents no screen reports, so they name nothing.
  "/unlock/door": ["gate.front-door"],
  "/unlock/form": ["gate.unlock", "gate.unlock.account"],
  "/unlock/passkey": ["gate.unlock.passkey"],
  "/unlock/signin": ["gate.sign-in"],
  "/setup/choose": ["gate.setup.choose"],
  "/setup/capabilities": ["gate.setup", "gate.setup.keep"],
  "/setup/identity": ["gate.setup.ways"],
  "/setup/connectors": ["gate.setup.connectors"],
  "/broker/authorize": ["gate.broker.consent"],
  "/federation": ["gate.federation.return"],
  "/identity/authorize": ["identity.local.siop.authorize"],

  // The vault. An empty one starts with the first item; after that, the way
  // around, then finding things.
  "/vault": [
    "vault.item.first",
    "shell.sections",
    "shell.sections.phone",
    "vault.item.find",
    "vault.import",
    "vault.export",
    "vault.lock",
    "client.support",
    "client.command-bar",
    "shell.statusline",
    "shell.more",
    "vaults.switch",
    "vault.keys.bar",
    "vault.keys.macros",
    "host.health.check",
    "vault.environments",
    "shell.sections.access",
    "shell.sections.connections",
    "shell.sections.identity",
    "identity.sign-out",
    "identity.switch-account",
  ],
  "/vault/list": [
    "vault.item.first",
    "vault.item.create",
    "vault.item.find",
    "vault.item.accounts",
    "vault.keys.move",
  ],
  "/vault/item": [
    "vault.item.copy",
    "vault.item.edit",
    "vault.item.favorite",
    "vault.item.share",
    "vault.item.trash",
  ],
  "/vault/trash": ["vault.item.trash"],
  "/vault/health": ["vault.health.review"],

  // Settings, one category at a time.
  "/settings": ["settings.general.review", "settings.auto-lock.set"],
  "/settings/keybindings": ["settings.keybindings.review"],
  "/settings/security": [
    "settings.security.review",
    "vault.recovery-codes",
    "vault.second-step.code",
  ],
  "/settings/vaults": ["settings.vaults.review", "vaults.manage"],
  "/settings/item-types": ["vault.item-types.install"],
  "/settings/features": ["settings.features.review"],
  "/settings/integrations": ["settings.integrations.review", "settings.backup"],
  "/settings/danger": ["settings.danger.review"],
  "/settings/notifications": ["settings.notifications"],
  "/settings/features/local-notifications": ["settings.local-notifications"],
  "/settings/features/networking": ["settings.tailnet-sync"],
  "/settings/features/ai/support.local-ai": ["settings.model-provider"],

  // The optional sections, each present only while its feature is on.
  "/activity": ["shell.sections.activity"],
  "/connections": [
    "connection.create",
    "connection.review",
    "connection.repair",
  ],
  "/connections/git": ["settings.backup"],
  "/access": ["access.review", "access.grant", "access.sessions.review"],
  "/access/requests": ["access.relay", "access.requests.hosted"],
  "/identity": [
    "identity.sign-in",
    "identity.account.add",
    "identity.approval.review",
    "identity.device.approve",
    "identity.interaction.approve",
    "identity.claim.accept",
    "identity.drop.open",
  ],
  "/wallet": ["shell.sections.wallet"],
} satisfies Readonly<Record<GuideRouteId, readonly GuideGoalId[]>>;

const TOURS_BY_ROUTE: ReadonlyMap<GuideRouteId, readonly GuideGoalId[]> =
  new Map(Object.entries(FIRST_VISIT_TOURS));

/** The route and each of its parents, nearest first. */
function lineage(route: GuideRouteId): GuideRouteId[] {
  const out: GuideRouteId[] = [];
  let at = route;
  while (at.length > 1) {
    out.push(at);
    const cut = at.lastIndexOf("/");
    if (cut <= 0) break;
    at = at.slice(0, cut);
  }
  return out;
}

/** Where each tour stands in the library, so the rest follow in its order. */
const LIBRARY_ORDER: ReadonlyMap<GuideGoalId, number> = new Map(
  TUTORIAL_AREAS.flatMap((area) => area.goals).map((id, at) => [id, at]),
);

const AUTHORED: ReadonlySet<GuideGoalId> = new Set(
  Object.values(FIRST_VISIT_TOURS).flat(),
);

/**
 * The screens a tour belongs to when no list above names it. A tour of a
 * Features or Integrations section belongs to that page; any other belongs to
 * the routes it is scoped to.
 */
function homeRoutes(goal: GuideGoalDescriptor): readonly GuideRouteId[] {
  if (goal.id.startsWith("feature.")) return ["/settings/features"];
  if (goal.id.startsWith("integration.")) return ["/settings/integrations"];
  return goal.routes;
}

/**
 * Every tour whose home is exactly `route` and that no authored list names,
 * in library order. This is what makes the offers complete: a tour written
 * for a screen is offered there without anybody adding it to a list.
 */
function scopedTours(route: GuideRouteId): readonly GuideGoalId[] {
  return mergedGuideGoals()
    .filter(
      (goal) => !AUTHORED.has(goal.id) && homeRoutes(goal).includes(route),
    )
    .map((goal) => goal.id)
    .sort(
      (a, b) =>
        (LIBRARY_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (LIBRARY_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** The route's own authored tours, else its nearest parent's. */
function authoredTours(route: GuideRouteId): readonly GuideGoalId[] {
  for (const at of lineage(route)) {
    const named = TOURS_BY_ROUTE.get(at);
    if (named !== undefined) return named;
  }
  return [];
}

/**
 * The tours a route may offer, in order: the ones authored to introduce it
 * (its own entry, else its nearest parent's), then every other tour whose
 * home is this route.
 */
export function firstVisitCandidates(
  route: GuideRouteId,
): readonly GuideGoalId[] {
  return [...authoredTours(route), ...scopedTours(route)];
}

/**
 * The walkthrough to offer on arriving at `route`, or null.
 *
 * `answered` is the goals this device already started or declined. The gate
 * is the library's own, so an offer can never name a tour the Tutorials tab
 * would refuse — a control that is not drawn, a requirement that does not
 * hold, a capability that is not installed.
 */
export function firstVisitTour(
  route: GuideRouteId,
  answered: ReadonlySet<string>,
  options: LibraryOptions = {},
): Tutorial | null {
  for (const id of firstVisitCandidates(route)) {
    if (answered.has(id)) continue;
    const goal = guideGoal(id);
    if (goal === null) continue;
    if (!tutorialStartsFrom(goal, route)) continue;
    if (!goalOffered(goal, options)) continue;
    return { goal, steps: tutorialStepCount(goal.guide) };
  }
  return null;
}
