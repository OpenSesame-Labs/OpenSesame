/**
 * Targets and routes the `wallet.spending` capability contributes.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const WALLET_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "nav.wallet",
    description:
      "Open Wallet to review budgets, spending, passes and payment methods.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const WALLET_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/wallet",
    title: "Wallet — spending overview, budgets and payment methods",
  },
];
