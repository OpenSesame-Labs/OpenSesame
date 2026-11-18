import { describe, expect, it } from "vitest";
import { workerVariantFromBoundary } from "./variant.js";

describe("service-worker variant boundary", () => {
  it("defaults a direct sw.js registration to core-only", () => {
    expect(workerVariantFromBoundary(undefined)).toBe("core-only");
  });

  it("accepts only the push wrapper's explicit marker", () => {
    expect(workerVariantFromBoundary("push")).toBe("push");
    for (const value of ["core-only", "Push", "", null, false, {}])
      expect(() => workerVariantFromBoundary(value)).toThrow(
        "Unknown service-worker variant boundary",
      );
  });
});
