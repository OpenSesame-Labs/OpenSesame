import { overlapCast } from "@opensesame/os-domain";
import { expect, vi } from "vitest";
import type { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

export function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

export async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

export async function verified(app: App, subject: string) {
  const created = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return created;
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export async function createOrg(app: App, token: string, slug: string) {
  const res = await app.request("/v1/organizations", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ slug, displayName: `Org ${slug}` }),
  });
  return res;
}

export function mockHostFetch(impl: () => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}
