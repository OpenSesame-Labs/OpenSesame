import { clearNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import {
  fakeAgentAnswering,
} from "@opensesame/support-agent";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  ask,
  mount,
  openPanel,
  resetSupport,
} from "./support-test-harness.js";

afterEach(() => {
  resetSupport();
  clearNotices();
});

describe("support keeps the exchange in sight", () => {
  it("scrolls the sheet body to the question just asked, so the answer is in sight", async () => {
    const user = userEvent.setup();
    const scrolled: { on: Element; top: number }[] = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (
      this: Element,
      options?: ScrollToOptions,
    ) {
      scrolled.push({ on: this, top: options?.top ?? 0 });
    } as typeof Element.prototype.scrollTo;
    try {
      mount(
        fakeAgentAnswering("The lock sits at the right of the statusline."),
      );
      const { panel } = await openPanel(user);
      await ask(user, "where is the lock");
      await screen.findByText("The lock sits at the right of the statusline.");
      const body = panel.querySelector(".support__body");
      // The person's own question caused exactly the causal scroll, on the
      // sheet's own scroller — never the page behind it.
      expect(scrolled.length).toBeGreaterThan(0);
      expect(scrolled.every((call) => call.on === body)).toBe(true);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });
});
