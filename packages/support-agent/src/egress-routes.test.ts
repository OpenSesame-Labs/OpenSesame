import fc from "fast-check";
import { expect, it } from "vitest";
import { SUPPORT_LIMITS } from "./contract.js";
import { sanitizeSupportRequest } from "./egress.js";
import { fakeSupportPageContext } from "./fake.js";

it("keeps authored routes while bounding and validating route egress", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 80 }), (count) => {
      const routes = Array.from({ length: count }, (_, index) => ({
        id: `/route-${index}`,
        title: "x".repeat(300),
      }));
      const result = sanitizeSupportRequest({
        question: "Help",
        history: [],
        context: { ...fakeSupportPageContext(), routes },
      });
      expect(result.context.routes).toHaveLength(
        Math.min(count, SUPPORT_LIMITS.maxRoutes),
      );
      expect(
        result.context.routes.every((route) => route.title.length === 240),
      ).toBe(true);
      expect(result.context.routes.map((route) => route.id)).toEqual(
        routes.slice(0, SUPPORT_LIMITS.maxRoutes).map((route) => route.id),
      );
    }),
  );
  const unexpectedRoute = {
    id: "/vault",
    title: "Vault",
    secret: "unexpected",
  };
  expect(() =>
    sanitizeSupportRequest({
      question: "Help",
      history: [],
      context: {
        ...fakeSupportPageContext(),
        routes: [unexpectedRoute],
      },
    }),
  ).toThrow();
});
