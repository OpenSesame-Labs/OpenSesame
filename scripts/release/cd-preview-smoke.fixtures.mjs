/**
 * Shared fixtures for the `cd-preview-smoke*.test.mjs` files: the test
 * runner, fake registry and Pages responses, and a manual clock.
 */
import { test as nodeTest } from "node:test";

// Vitest collects calls named test. test:ci-promotion runs these files with
// node:test, so load vitest only when that runner set VITEST.
export const test = process.env.VITEST
  ? (await import("vitest")).test
  : nodeTest;

export const version = "0.0.0-alpha.4";
export const sha = "b".repeat(40);
export const pagesUrl = "https://opensesame-labs.github.io/OpenSesame/";

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body.length === undefined ? JSON.stringify(body) : body),
  };
}

export function distTags(alpha = version) {
  return jsonResponse(200, { alpha });
}

export function viewResult(stdout, status = 0) {
  return { status, stdout, stderr: "" };
}

export function versionDoc(seen = version, status = 200) {
  return jsonResponse(status, { version: seen });
}

export function packumentDoc(seen = version) {
  return jsonResponse(200, { versions: { [seen]: { version: seen } } });
}

export function registryReadKind(url) {
  const { pathname } = new URL(String(url));
  if (pathname.endsWith("/dist-tags")) return "dist-tags";
  if (/^\/@opensesame-labs%2f[^/]+$/u.test(pathname)) return "packument";
  if (/^\/@opensesame-labs%2f[^/]+\/[^/]+$/u.test(pathname)) return "version";
  return "other";
}

export function cacheBustOf(url) {
  return new URL(String(url)).searchParams.get("_cd_wait");
}

export function page(
  status = 200,
  body = "<!doctype html><title>OpenSesame</title>",
) {
  return jsonResponse(status, body);
}

export function manualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

export const oneShot = {
  SMOKE_REGISTRY_DEADLINE_MS: "0",
  SMOKE_REGISTRY_POLL_MS: "10000",
};

export const oneRetry = {
  SMOKE_REGISTRY_DEADLINE_MS: "10000",
  SMOKE_REGISTRY_POLL_MS: "10000",
};
