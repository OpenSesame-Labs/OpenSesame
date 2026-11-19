import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const SHOP_PASSWORD = "a long unique passphrase for the shop";
const SHOP_PWNED_RANGE_PREFIX = "D9623";

test("shop pwned range prefix matches SHA-1 k-anonymity convention", () => {
  const prefix = createHash("sha1")
    .update(SHOP_PASSWORD)
    .digest("hex")
    .toUpperCase()
    .slice(0, 5);
  assert.equal(prefix, SHOP_PWNED_RANGE_PREFIX);
});