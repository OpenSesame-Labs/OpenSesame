import { expect, it } from "vitest";
import { OrgSignInError } from "./org-signin.js";

it("explains when old token records require pages and when capacity blocks minting", () => {
  expect(new OrgSignInError(409, "pagination_required").message).toContain(
    "paginated Identity API",
  );
  expect(new OrgSignInError(409, "scim_token_capacity").message).toContain(
    "Revoke an existing token",
  );
  expect(new OrgSignInError(429, "rate_limited").message).toContain(
    "Wait a minute",
  );
});
