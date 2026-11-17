import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveProvisionalSession } from "../middleware/auth.js";
import { principalForBetterAuthSubject } from "../services/better-auth-bridge.js";
import { firstPartyMagicRequest } from "./magic-link-first-party.fixture.js";

const pagesOrigin = "https://pages.example.test";

it("does not publish a returning magic-link session while deprovisioning is fenced", async () => {
  const { ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  await ctx.systemPrincipalReady;
  const subject = {
    id: "ba_returning_user",
    email: "returning@example.test",
    emailVerified: true,
  };
  const initial = await principalForBetterAuthSubject(ctx, subject);
  const sessionsBefore = await ctx.stores.provisionalSessions.size;
  const tokensBefore = await ctx.stores.provisionalTokens.size;
  await ctx.stores.principalSessionEpochs.set(initial.principalId, {
    generation: 1,
    operations: ["organization:deprovision"],
  });

  let refused = false;
  try {
    await principalForBetterAuthSubject(ctx, subject);
  } catch (error) {
    expect(error).toMatchObject({ code: "session_interrupted" });
    refused = true;
  }
  expect(refused).toBe(true);
  expect(await ctx.stores.provisionalSessions.size).toBe(sessionsBefore);
  expect(await ctx.stores.provisionalTokens.size).toBe(tokensBefore);

  await ctx.stores.principalSessionEpochs.set(initial.principalId, {
    generation: 2,
    operations: [],
  });
  const retried = await principalForBetterAuthSubject(ctx, subject);
  expect(retried.principalId).toBe(initial.principalId);
  expect(
    await resolveProvisionalSession(ctx, retried.accessToken),
  ).toMatchObject({
    principalId: initial.principalId,
  });
});

it("tells a returning email user to request a new link after an interrupted sign-in", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
      corsOrigins: [pagesOrigin],
    },
  });
  await ctx.systemPrincipalReady;
  const email = "fenced-link@example.test";
  const requestLink = async () => {
    const attempt = firstPartyMagicRequest(email, pagesOrigin);
    const response = await app.request(
      "/v1/auth/sign-in/magic-link",
      attempt.init,
    );
    expect(response.status).toBe(200);
    const message: { text?: string } = overlapCast(
      JSON.parse(ctx.mailer.outbox.at(-1)?.body ?? "{}"),
    );
    const link = message.text?.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error("Expected a sign-in link");
    return { link: new URL(link), attempt };
  };
  const confirm = (link: URL) =>
    app.request(link.pathname, {
      method: "POST",
      body: new URLSearchParams(link.hash.slice(1)),
    });
  const finish = async (value: Awaited<ReturnType<typeof requestLink>>) => {
    const response = await confirm(value.link);
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location") ?? "");
    return app.request("/v1/auth/magic-link/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: pagesOrigin },
      body: JSON.stringify({
        code: target.searchParams.get("magic_code"),
        codeVerifier: value.attempt.verifier,
        state: value.attempt.state,
      }),
    });
  };

  const first = await finish(await requestLink());
  expect(first.status).toBe(200);
  const initial: { principalId: string } = overlapCast(await first.json());
  await ctx.stores.principalSessionEpochs.set(initial.principalId, {
    generation: 1,
    operations: ["organization:deprovision"],
  });
  const interruptedLink = await requestLink();
  const interrupted = await finish(interruptedLink);
  expect(interrupted.status).toBe(409);
  expect(await interrupted.json()).toEqual({
    error: "session_interrupted",
    message: "Sign-in was interrupted. Request a new sign-in link.",
  });
  expect((await confirm(interruptedLink.link)).status).toBe(401);

  await ctx.stores.principalSessionEpochs.set(initial.principalId, {
    generation: 2,
    operations: [],
  });
  const retried = await finish(await requestLink());
  expect(retried.status).toBe(200);
  const session: {
    principalId: string;
    accessToken: string;
  } = overlapCast(await retried.json());
  expect(session.principalId).toBe(initial.principalId);
  expect(
    await resolveProvisionalSession(ctx, session.accessToken),
  ).toMatchObject({
    principalId: initial.principalId,
  });
});
