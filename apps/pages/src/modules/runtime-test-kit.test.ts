/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ImportSideEffects,
  NO_SIDE_EFFECTS,
  importUnderSpies,
} from "./runtime-test-kit.js";

/**
 * A fresh module per call: the source carries a nonce, so each URL is a
 * module the runner has never evaluated.
 */
let nonce = 0;
function fixture(body: string): () => Promise<object> {
  nonce += 1;
  const url = `data:text/javascript,${encodeURIComponent(
    `${body}\nexport const fixture = ${nonce};`,
  )}`;
  return () => import(/* @vite-ignore */ url);
}

const EFFECTS = {
  fetch: 'void globalThis.fetch("https://kit.invalid/").catch(() => {});',
  setTimeout: "globalThis.setTimeout(() => {}, 0);",
  setInterval: "clearInterval(globalThis.setInterval(() => {}, 60000));",
  serviceWorkerRegister:
    'void navigator.serviceWorker.register("/sw.js").catch(() => {});',
  windowListeners: 'window.addEventListener("focus", () => {});',
  documentListeners: 'document.addEventListener("click", () => {});',
  customElements: `customElements.define("kit-probe-${Date.now()}", class extends HTMLElement {});`,
  storageWrites: 'localStorage.setItem("kit-probe", "1");',
} satisfies Record<keyof ImportSideEffects, string>;

const EFFECT_NAMES: readonly (keyof ImportSideEffects)[] = [
  "fetch",
  "setTimeout",
  "setInterval",
  "serviceWorkerRegister",
  "windowListeners",
  "documentListeners",
  "customElements",
  "storageWrites",
];

describe("importUnderSpies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("kit-probe");
  });

  it("reports a clean module as NO_SIDE_EFFECTS", async () => {
    const loaded = await importUnderSpies(fixture("const quiet = 1;"));
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("names every effect the kit counts", () => {
    expect([...EFFECT_NAMES].sort()).toEqual(
      Object.keys(NO_SIDE_EFFECTS).sort(),
    );
  });

  for (const effect of EFFECT_NAMES) {
    it(`counts ${effect} performed at import`, async () => {
      const loaded = await importUnderSpies(fixture(EFFECTS[effect]));
      expect(loaded.effects[effect]).toBe(1);
      expect(loaded.effects).toEqual({ ...NO_SIDE_EFFECTS, [effect]: 1 });
    });
  }

  it("reports a cached module's first evaluation, not the cache hit", async () => {
    // Vitest `retry` re-runs a failed test against the evaluated graph: the
    // second import evaluates nothing, so it must not read as clean.
    const load = fixture(EFFECTS.setTimeout);
    const first = await importUnderSpies(load);
    const again = await importUnderSpies(load);
    expect(again.module).toBe(first.module);
    expect(again.effects).toEqual(first.effects);
    expect(again.effects.setTimeout).toBe(1);
  });
});
