import { afterEach, expect, it, vi } from "vitest";
import { createTutorialPageFactory } from "./tutorial-page.mjs";

afterEach(() => vi.unstubAllGlobals());

it("records ResizeObserver delivery errors without suppressing other events", async () => {
  let onError;
  let binding;
  let init;
  const page = {
    exposeBinding: async (_name, handler) => {
      binding = handler;
    },
  };
  const context = {
    addInitScript: async (script) => {
      init = script;
    },
  };
  const harness = { newPage: async () => ({ page, context }), record: vi.fn() };
  vi.stubGlobal("window", {
    addEventListener: (_type, handler) => {
      onError = handler;
    },
    __recordTutorialResizeError: () => binding({}),
  });

  await createTutorialPageFactory({ browser: {}, devUrl: "", harness })(390);
  init();
  onError({ message: "Unrelated error" });
  expect(harness.record).not.toHaveBeenCalled();
  onError({
    message: "ResizeObserver loop completed with undelivered notifications.",
  });
  expect(harness.record).toHaveBeenCalledWith(
    "PAGE-ERROR",
    "ResizeObserver loop notification",
  );
});
