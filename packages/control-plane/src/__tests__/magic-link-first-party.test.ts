import { createHash, randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { resetMagicLinkUpgradeTelemetryForTest } from "../routes/auth-upstream.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

const origin = "https://pages.example.test";
const callback = `${origin}/OpenSesame/device?user_code=ABCD-EFGH`;
type Started = Awaited<ReturnType<typeof startServer>>;
let started: Started;
let base = "";

beforeAll(async () => {
  const { startServer: start } = await import("../server.js");
  started = await onFreePort((port) =>
    start({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
        corsOrigins: [origin],
        clientAppUrl: `${origin}/OpenSesame`,
      },
      processEnv: { ...process.env, OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true" },
    }),
  );
  base = `http://127.0.0.1:${started.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    started.server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function requestedLink(email: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const response = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email,
      callbackURL: callback,
      codeChallenge: challenge,
      state,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: true });
  const message: { text?: string } = overlapCast(
    JSON.parse(started.ctx.mailer.outbox.at(-1)?.body ?? "{}"),
  );
  const link = message.text?.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("The email has no sign-in link.");
  return { link: new URL(link), verifier, state };
}

async function exchange(
  code: string,
  verifier: string,
  state: string,
  from = origin,
) {
  return fetch(`${base}/v1/auth/magic-link/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: from },
    body: JSON.stringify({ code, codeVerifier: verifier, state }),
  });
}

async function confirm(
  link: URL,
  values = new URLSearchParams(link.hash.slice(1)),
) {
  return fetch(`${link.origin}${link.pathname}`, {
    method: "POST",
    redirect: "manual",
    body: values,
  });
}

it("returns to the requested device flow with a single-use verifier-bound code", async () => {
  const request = await requestedLink("magic-return@example.test");
  expect(request.link.search).toBe("");
  const scanner = await fetch(request.link);
  expect(scanner.status).toBe(200);
  expect(scanner.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(scanner.headers.get("content-security-policy")).toContain(
    `form-action 'self' ${origin}`,
  );
  const page = await scanner.text();
  expect(page).toContain("history.replaceState");
  expect(page).toContain('type="submit" disabled');
  const fields = new URLSearchParams(request.link.hash.slice(1));
  const withoutContext = new URLSearchParams(fields);
  withoutContext.delete("return");
  expect((await confirm(request.link, withoutContext)).status).toBe(401);
  const altered = new URLSearchParams(fields);
  altered.set("return", `${altered.get("return")}x`);
  expect((await confirm(request.link, altered)).status).toBe(401);

  const clicks = await Promise.all([
    confirm(request.link),
    confirm(request.link),
  ]);
  expect(clicks.map((response) => response.status).sort()).toEqual([303, 401]);
  const completed = clicks.find((response) => response.status === 303);
  if (!completed) throw new Error("The verified link did not return.");
  expect(completed.headers.get("cache-control")).toBe("no-store");
  expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
  const target = new URL(completed.headers.get("location") ?? "");
  expect(target.origin + target.pathname).toBe(`${origin}/OpenSesame/device`);
  expect(target.searchParams.get("user_code")).toBe("ABCD-EFGH");
  expect(target.searchParams.get("magic_state")).toBe(request.state);
  const code = target.searchParams.get("magic_code") ?? "";
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(target.toString()).not.toContain("pst_");
  expect(target.toString()).not.toContain(request.verifier);
  expect(target.toString()).not.toContain(fields.get("token") ?? "no-token");

  const result = await exchange(code, request.verifier, request.state);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  const session: { principalId: string; accessToken: string } = overlapCast(
    await result.json(),
  );
  expect(session.principalId).toMatch(/^prn_/u);
  expect(session.accessToken).toMatch(/^pst_/u);
  expect(target.toString()).not.toContain(session.accessToken);
  expect((await exchange(code, request.verifier, request.state)).status).toBe(
    401,
  );
});

it("burns a code on a wrong verifier and rejects unsafe callbacks before email", async () => {
  const request = await requestedLink("wrong-verifier@example.test");
  const response = await confirm(request.link);
  const target = new URL(response.headers.get("location") ?? "");
  const code = target.searchParams.get("magic_code") ?? "";
  expect(
    (await exchange(code, randomBytes(32).toString("base64url"), request.state))
      .status,
  ).toBe(401);
  expect((await exchange(code, request.verifier, request.state)).status).toBe(
    401,
  );

  const before = started.ctx.mailer.outbox.length;
  for (const unsafe of [
    "https://evil.example/OpenSesame/device",
    origin,
    `${origin}/other-app`,
    `${origin}/OpenSesame/device?access_token=secret`,
    `${origin}/OpenSesame/device#fragment`,
  ]) {
    const refused = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: "unsafe@example.test",
        callbackURL: unsafe,
        codeChallenge: createHash("sha256")
          .update(request.verifier)
          .digest("base64url"),
        state: request.state,
      }),
    });
    expect(refused.status).toBe(400);
  }
  const budgetBefore = structuredClone(
    started.ctx.stores.magicLinkBudgets.get("deployment"),
  );
  resetMagicLinkUpgradeTelemetryForTest();
  const logged = vi.spyOn(started.ctx.log, "warn").mockImplementation(() => {});
  const untrusted = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://untrusted.example.test",
    },
    body: JSON.stringify({
      email: "unsafe@example.test",
      callbackURL: "https://untrusted.example.test/callback",
    }),
  });
  expect(untrusted.status).toBe(400);
  expect(logged).not.toHaveBeenCalled();
  const downgrade = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "unsafe@example.test",
      callbackURL: origin,
    }),
  });
  expect(downgrade.status).toBe(426);
  expect(downgrade.headers.get("cache-control")).toBe("no-store");
  expect(await downgrade.json()).toEqual({
    error: "client_upgrade_required",
    requiredProtocol: "magic-link-pkce-v1",
    action: "reload",
  });
  expect(started.ctx.stores.magicLinkBudgets.get("deployment")).toEqual(
    budgetBefore,
  );
  expect(logged).toHaveBeenCalledWith(
    {
      event: "magic_link_client_upgrade_required",
      requiredProtocol: "magic-link-pkce-v1",
      suppressedSinceLast: 0,
    },
    "legacy magic-link request refused",
  );
  const sampled = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "unsafe@example.test",
      callbackURL: origin,
    }),
  });
  expect(sampled.status).toBe(426);
  expect(logged).toHaveBeenCalledTimes(1);
  logged.mockRestore();
  expect(started.ctx.mailer.outbox).toHaveLength(before);
});
