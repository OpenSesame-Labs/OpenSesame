import { createHash, randomBytes } from "node:crypto";
import { createEventSealer } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { DurableMap, type SecurityMap } from "../repos/durable-map.js";
import {
  chargeAuthenticationMagicLinkBudget,
  chargeMagicLinkBudget,
} from "../services/magic-link-budget.js";
import {
  type MagicLinkExchange,
  consumeMagicLinkExchange,
  issueMagicLinkExchange,
} from "../services/magic-link-exchange.js";
import type { MfaCodeSendWindow } from "../state.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);
const subject = {
  id: "upstream-subject-fixture",
  email: "verified@example.test",
  emailVerified: true,
};
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(24).toString("base64url");
const origin = "https://pages.example.test";
const context = (
  store: SecurityMap<MagicLinkExchange>,
  clock = () => new Date(),
) =>
  overlapCast<unknown, AppContext>({
    stores: { magicLinkExchanges: store },
    clock,
  });

it("binds an exchange to its verifier and state and burns a wrong attempt", async () => {
  const ctx = context(new Map());
  const code = await issueMagicLinkExchange(
    ctx,
    subject,
    challenge,
    state,
    origin,
  );
  const wrong = randomBytes(32).toString("base64url");
  expect(
    await consumeMagicLinkExchange(ctx, code, wrong, state, origin),
  ).toBeUndefined();
  expect(
    await consumeMagicLinkExchange(ctx, code, verifier, state, origin),
  ).toBeUndefined();
  const next = await issueMagicLinkExchange(
    ctx,
    subject,
    challenge,
    state,
    origin,
  );
  expect(
    await consumeMagicLinkExchange(ctx, next, verifier, state, origin),
  ).toEqual(subject);
  expect(
    await consumeMagicLinkExchange(ctx, next, verifier, state, origin),
  ).toBeUndefined();
});

it("expires an unused exchange", async () => {
  let now = Date.now();
  const ctx = context(new Map(), () => new Date(now));
  const code = await issueMagicLinkExchange(
    ctx,
    subject,
    challenge,
    state,
    origin,
  );
  now += 5 * 60_000;
  expect(
    await consumeMagicLinkExchange(ctx, code, verifier, state, origin),
  ).toBeUndefined();
});

it("does not allow an exchange from a different origin", async () => {
  const ctx = context(new Map());
  const code = await issueMagicLinkExchange(
    ctx,
    subject,
    challenge,
    state,
    origin,
  );
  expect(
    await consumeMagicLinkExchange(
      ctx,
      code,
      verifier,
      state,
      "https://other.example",
    ),
  ).toBeUndefined();
  expect(
    await consumeMagicLinkExchange(ctx, code, verifier, state, origin),
  ).toBeUndefined();
});

it("encrypts its record and admits one exchange across replicas", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const store = () =>
      new DurableMap<MagicLinkExchange>(
        overlapCast(db),
        "OpenSesame:MagicLinkExchange",
        true,
        300_000,
        10_000,
        createEventSealer("magic-link-exchange-fixture"),
      );
    const first = context(store());
    const second = context(store());
    const code = await issueMagicLinkExchange(
      first,
      subject,
      challenge,
      state,
      origin,
    );
    const rows = JSON.stringify(await db.select().from(schema.oidcPayloads));
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(subject.email);
    const results = await Promise.all([
      consumeMagicLinkExchange(first, code, verifier, state, origin),
      consumeMagicLinkExchange(second, code, verifier, state, origin),
    ]);
    expect(results.filter(Boolean)).toEqual([subject]);
  } finally {
    await client.close();
  }
});

it("enforces a shared per-address send budget across replicas", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const store = () =>
      new DurableMap<MfaCodeSendWindow>(
        overlapCast(db),
        "OpenSesame:MfaCodeSend",
        false,
        3_600_000,
        10_000,
        createEventSealer("magic-link-budget-fixture"),
      );
    const budgetContext = () =>
      overlapCast<unknown, AppContext>({
        stores: { mfaCodeSends: store() },
        config: { claimPepper: "shared-budget-fixture-key" },
        clock: () => new Date(),
      });
    const first = budgetContext();
    const second = budgetContext();
    const email = "limited-recipient@example.test";
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        chargeMagicLinkBudget(index % 2 ? first : second, email),
      ),
    );
    expect(results.filter((result) => result === "ok")).toHaveLength(5);
    expect(results.filter((result) => result === "recipient")).toHaveLength(1);
    expect(
      JSON.stringify(await db.select().from(schema.oidcPayloads)),
    ).not.toContain(email);
  } finally {
    await client.close();
  }
});

it("does not reset the send budget if the clock moves backward", async () => {
  let now = Date.now();
  const ctx = overlapCast<unknown, AppContext>({
    stores: { mfaCodeSends: new Map() },
    config: { claimPepper: "budget-clock-fixture" },
    clock: () => new Date(now),
  });
  for (let attempt = 0; attempt < 5; attempt++)
    expect(await chargeMagicLinkBudget(ctx, "clock@example.test")).toBe("ok");
  now -= 60_000;
  expect(await chargeMagicLinkBudget(ctx, "clock@example.test")).toBe(
    "recipient",
  );
  now += 11 * 60_000;
  expect(await chargeMagicLinkBudget(ctx, "clock@example.test")).toBe("ok");
});

it("limits rotating recipients by source without draining global on refusal", async () => {
  const ctx = overlapCast<unknown, AppContext>({
    stores: { mfaCodeSends: new Map() },
    config: { claimPepper: "source-budget-fixture" },
    clock: () => new Date(),
  });
  for (let attempt = 0; attempt < 20; attempt++)
    expect(
      await chargeMagicLinkBudget(
        ctx,
        `rotated-${attempt}@example.test`,
        "192.0.2.20",
      ),
    ).toBe("ok");
  expect(
    await chargeMagicLinkBudget(ctx, "next@example.test", "192.0.2.20"),
  ).toBe("source");
  expect(
    await chargeMagicLinkBudget(ctx, "limited@example.test", "192.0.2.21"),
  ).toBe("ok");
  for (let attempt = 0; attempt < 4; attempt++)
    await chargeMagicLinkBudget(
      ctx,
      "limited@example.test",
      `192.0.2.${attempt + 30}`,
    );
  for (let attempt = 0; attempt < 25; attempt++)
    expect(
      await chargeMagicLinkBudget(
        ctx,
        "limited@example.test",
        `192.0.2.${attempt + 60}`,
      ),
    ).toBe("recipient");
  expect(
    await chargeMagicLinkBudget(ctx, "fresh@example.test", "192.0.2.22"),
  ).toBe("ok");
});

it("bounds authenticated backend mail per application and recipient", async () => {
  const ctx = overlapCast<unknown, AppContext>({
    stores: { mfaCodeSends: new Map() },
    config: { claimPepper: "backend-budget-fixture" },
    clock: () => new Date(),
  });
  for (let attempt = 0; attempt < 5; attempt++)
    expect(
      await chargeAuthenticationMagicLinkBudget(
        ctx,
        "app_one",
        "recipient@example.test",
      ),
    ).toBe(true);
  expect(
    await chargeAuthenticationMagicLinkBudget(
      ctx,
      "app_one",
      "recipient@example.test",
    ),
  ).toBe(false);
  expect(
    await chargeAuthenticationMagicLinkBudget(
      ctx,
      "app_two",
      "recipient@example.test",
    ),
  ).toBe(true);
});
