import { expect, it } from "vitest";
import { SUPPORT_LIMITS } from "./contract.js";
import { sanitizeSupportRequest } from "./egress.js";
import { fakeSupportPageContext } from "./fake.js";

it("caps each oversized context list at its egress budget", () => {
  const targets = Array.from(
    { length: SUPPORT_LIMITS.maxTargets + 10 },
    (_, index) => ({
      id: `target.n${index}`,
      description: "a control",
      role: "action" as const,
      mounted: true,
    }),
  );
  const goals = Array.from(
    { length: SUPPORT_LIMITS.maxGoals + 10 },
    (_, index) => ({
      id: `goal.n${index}`,
      title: "a goal",
    }),
  );
  const routes = Array.from(
    { length: SUPPORT_LIMITS.maxRoutes + 10 },
    (_, index) => ({
      id: `/route-${index}`,
      title: "a route",
    }),
  );
  const sanitized = sanitizeSupportRequest({
    question: "hello",
    history: [],
    context: { ...fakeSupportPageContext(), targets, goals, routes },
  });
  expect(sanitized.context.targets).toHaveLength(SUPPORT_LIMITS.maxTargets);
  expect(sanitized.context.goals).toHaveLength(SUPPORT_LIMITS.maxGoals);
  expect(sanitized.context.routes).toHaveLength(SUPPORT_LIMITS.maxRoutes);
  expect(sanitized.context.routes.at(-1)?.id).toBe(
    `/route-${SUPPORT_LIMITS.maxRoutes - 1}`,
  );
});
