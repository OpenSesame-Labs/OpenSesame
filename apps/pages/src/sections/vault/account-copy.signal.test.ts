import {
  type RecommendationTrigger,
  subscribeRecommendationSignals,
} from "@opensesame/app-core/lib/recommendations.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountCopied } from "./account-copy.js";
import { makeAccount } from "./section-items.test-support.js";

let heard: RecommendationTrigger[] = [];
let stop = () => {};

beforeEach(() => {
  heard = [];
  stop = subscribeRecommendationSignals((trigger) => heard.push(trigger));
});
afterEach(() => stop());

describe("what an account's copy says to the recommender (ADR 0221)", () => {
  it("says a password was copied when the account has one", () => {
    accountCopied(makeAccount({ id: "a", name: "GitHub" }))("copied");
    expect(heard).toEqual(["password.copied"]);
  });

  it("says nothing when the copy failed", () => {
    accountCopied(makeAccount({ id: "a", name: "GitHub" }))("failed");
    expect(heard).toEqual([]);
  });

  it("says nothing for an account with no password: autofill fills none", () => {
    // Its copy falls back to an API key or token line.
    accountCopied(makeAccount({ id: "a", name: "API", methods: [] }))("copied");
    expect(heard).toEqual([]);
  });
});
