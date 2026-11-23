/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { ownedAssetURL } from "./sdk.js";

const origin = globalThis.location.origin;

it("keeps an owned runtime asset at its own path on this deployment", () => {
  const href = `${origin}/assets/tailscale/main.wasm.gz`;
  expect(ownedAssetURL(href)).toBe(href);
});

it("rebuilds the asset on this origin so a path cannot name another host", () => {
  const resolved = new URL(ownedAssetURL(`${origin}//elsewhere.example/x.js`));
  expect(resolved.origin).toBe(origin);
  expect(resolved.pathname).toBe("//elsewhere.example/x.js");
});

it("refuses runtime assets that do not belong to this deployment", () => {
  for (const href of [
    "https://cdn.example/assets/main.wasm.gz",
    `${origin}/assets/main.wasm.gz?version=1`,
    `${origin}/assets/main.wasm.gz#fragment`,
    `${origin.replace("://", "://user:pass@")}/assets/main.wasm.gz`,
  ])
    expect(() => ownedAssetURL(href)).toThrow(
      "Tailscale runtime assets must belong to this deployment.",
    );
});
