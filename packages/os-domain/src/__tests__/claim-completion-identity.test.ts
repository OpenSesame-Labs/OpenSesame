import { expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  authenticateClaim,
  completeClaim,
  presentClaim,
  reviewClaim,
} from "../machines/claim.js";
import { fixtures } from "./fixtures.js";

it("rejects an empty completion identity without changing the reviewed claim", () => {
  const pending = fixtures.pendingClaim().session;
  const presented = presentClaim(pending, fixtures.now);
  const authenticated = authenticateClaim(presented, fixtures.now);
  const reviewed = reviewClaim(authenticated, {}, fixtures.now);
  const before = structuredClone(reviewed);
  expect(() => completeClaim(reviewed, "", fixtures.now)).toThrow(DomainError);
  expect(reviewed).toEqual(before);
});
