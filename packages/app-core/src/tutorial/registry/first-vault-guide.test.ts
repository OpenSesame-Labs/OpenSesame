/** @vitest-environment jsdom */
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { expect, it } from "vitest";
import {
  FIRST_VAULT_PACK_GUIDE,
  FIRST_VAULT_SHELL_GUIDE,
  FIRST_VAULT_SIGNIN_GUIDE,
} from "./first-vault-guide.js";
import { guideGoalIds } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";

it("compiles every first-vault continuation against the live catalog", () => {
  registerGuidePredicates();
  const revoke = registerTutorialRealm();
  try {
    const vocabulary = {
      goals: guideGoalIds(),
      targets: guideTargetIds(),
      routes: mergedGuideRoutes().map((route) => route.id),
      predicates: guidePredicateIds(),
    };
    for (const source of [
      FIRST_VAULT_SHELL_GUIDE,
      FIRST_VAULT_PACK_GUIDE,
      FIRST_VAULT_SIGNIN_GUIDE,
    ]) {
      expect(
        compileGuide(source, vocabulary, AUTHORED_GUIDE_LIMITS),
      ).toMatchObject({ ok: true });
    }
  } finally {
    revoke();
  }
});
