import { clearNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import {
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
} from "@opensesame/support-agent";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { SupportEntry } from "../session.js";
import {
  ask,
  mount,
  openPanel,
  resetSupport,
  showQuestions,
} from "./support-test-harness.js";
import { useAskOnQuestion, useSupportScroll } from "./use-support-scroll.js";

afterEach(() => {
  resetSupport();
  clearNotices();
});

describe("support keeps the exchange in sight", () => {
  it("scrolls the sheet body to the question just asked, so the answer is in sight", async () => {
    const user = userEvent.setup();
    const scrolled: { on: Element; top: number }[] = [];
    const original = Element.prototype.scrollTo;
    // SAFETY: the double implements scrollTo's same checked signature; restored in finally.
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

function entry(id: string, kind: SupportEntry["kind"]): SupportEntry {
  return {
    id,
    kind,
    text: id,
    suggestions: [],
    thoughts: null,
    computer: [],
    walkthroughs: [],
  };
}

function Thread({
  entries,
  mounted = true,
  onJump,
}: {
  entries: readonly SupportEntry[];
  mounted?: boolean;
  onJump?: () => void;
}) {
  const scroll = useSupportScroll(entries, undefined, onJump);
  return (
    <div ref={scroll.bodyRef} data-testid="body">
      {scroll.unseenAnswer ? (
        <button type="button" onClick={scroll.jumpToAnswer}>
          New answer
        </button>
      ) : null}
      {mounted ? (
        <section ref={scroll.threadRef}>
          {entries.map((item) => (
            <article key={item.id}>{item.id}</article>
          ))}
        </section>
      ) : null}
    </div>
  );
}

describe("support scroll, entry by entry", () => {
  it("scrolls when written help lands question and answer together", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollTo;
    // SAFETY: the double implements the same scroller contract; restored in finally.
    Element.prototype.scrollTo = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollTo;
    try {
      mount(fakeAgentAlwaysUnavailable("no_local_model"));
      const { panel } = await openPanel(user);
      await showQuestions(user);
      scrolled.length = 0;
      await user.click(
        within(panel).getByRole("button", {
          name: "Where do I lock the vault?",
        }),
      );
      await screen.findByText(/Locking drops the vault keys/);
      const body = panel.querySelector(".support__body");
      // The pair arrived in one breath; the question in it is still causal.
      expect(scrolled.length).toBeGreaterThan(0);
      expect(scrolled.every((on) => on === body)).toBe(true);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it("offers New answer for a below-fold arrival, and the key jumps to it", async () => {
    const user = userEvent.setup();
    // jsdom has no layout: the body ends at 100, the late answer at 300.
    // SAFETY: fixture rect — the checked hook reads only top/bottom on this seam.
    const rect = (bottom: number): DOMRect =>
      ({
        top: bottom - 40,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: 40,
        x: 0,
        y: bottom - 40,
        toJSON() {},
      }) as DOMRect;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset.testid === "body") return rect(100);
      return rect(this.textContent === "late" ? 300 : 60);
    };
    const scrolled: Element[] = [];
    const originalScroll = Element.prototype.scrollTo;
    // SAFETY: the double implements the same scroller contract; restored in finally.
    Element.prototype.scrollTo = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollTo;
    try {
      const first = [entry("q1", "question"), entry("a1", "answer")];
      const { rerender } = render(<Thread entries={first} />);
      expect(screen.queryByRole("button", { name: "New answer" })).toBeNull();
      scrolled.length = 0;
      rerender(<Thread entries={[...first, entry("late", "answer")]} />);
      const jump = await screen.findByRole("button", { name: "New answer" });
      // The arrival alone never moved the viewport.
      expect(scrolled).toHaveLength(0);
      await user.click(jump);
      expect(scrolled).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "New answer" })).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Element.prototype.scrollTo = originalScroll;
    }
  });

  it("marks an answer unseen when it lands while the thread is unmounted", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const originalScroll = Element.prototype.scrollTo;
    // SAFETY: the double implements the same scroller contract; restored in finally.
    Element.prototype.scrollTo = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollTo;
    try {
      const first = [entry("q1", "question"), entry("a1", "answer")];
      const { rerender } = render(<Thread entries={first} />);
      scrolled.length = 0;
      // The Tutorials tab replaces the thread after the first exchange was seen.
      rerender(<Thread entries={first} mounted={false} />);
      rerender(
        <Thread
          entries={[...first, entry("late", "answer")]}
          mounted={false}
        />,
      );
      expect(scrolled).toHaveLength(0);
      // The panel flips to Ask and the thread mounts: the chip is waiting.
      rerender(<Thread entries={[...first, entry("late", "answer")]} />);
      const jump = await screen.findByRole("button", { name: "New answer" });
      await user.click(jump);
      expect(scrolled).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "New answer" })).toBeNull();
    } finally {
      Element.prototype.scrollTo = originalScroll;
    }
  });
});

describe("tab follow and jump focus (Kimi a11y seat)", () => {
  it("flips to Ask only for the person's own question, never an async answer", () => {
    const flips: string[] = [];
    const Probe = ({ entries }: { entries: readonly SupportEntry[] }) => {
      useAskOnQuestion(entries, (tab) => flips.push(tab));
      return null;
    };
    const first = [entry("q1", "question")];
    const { rerender } = render(<Probe entries={first} />);
    expect(flips).toEqual([]);
    rerender(<Probe entries={[...first, entry("a1", "answer")]} />);
    expect(flips).toEqual([]);
    rerender(
      <Probe
        entries={[...first, entry("a1", "answer"), entry("q2", "question")]}
      />,
    );
    expect(flips).toEqual(["ask"]);
  });

  it("lands focus on the composer when the New answer key unmounts itself", async () => {
    const user = userEvent.setup();
    const rect = (bottom: number): DOMRect =>
      ({
        top: bottom - 40,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: 40,
        x: 0,
        y: bottom - 40,
        toJSON() {},
      }) as DOMRect;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("support__body")) return rect(100);
      return rect(this.textContent?.includes("The lock sits") ? 300 : 60);
    };
    try {
      mount(
        fakeAgentAnswering("The lock sits at the right of the statusline."),
      );
      await openPanel(user);
      await ask(user, "where is the lock");
      const chip = await screen.findByRole("button", {
        name: /New answer/,
      });
      chip.focus();
      await user.click(chip);
      expect(screen.queryByRole("button", { name: /New answer/ })).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText("Ask about this screen"),
      );
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });
});

describe("the New answer key on the Tutorials tab (Grok round 4)", () => {
  it("is offered while the thread is unmounted, and choosing it moves the panel and pays the scroll on mount", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const originalScroll = Element.prototype.scrollTo;
    // SAFETY: the double implements the same scroller contract; restored in finally.
    Element.prototype.scrollTo = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollTo;
    const jumps: number[] = [];
    const onJump = () => jumps.push(1);
    try {
      const first = [entry("q1", "question")];
      const { rerender } = render(
        <Thread entries={first} mounted={false} onJump={onJump} />,
      );
      rerender(
        <Thread
          entries={[...first, entry("late", "answer")]}
          mounted={false}
          onJump={onJump}
        />,
      );
      const chip = await screen.findByRole("button", {
        name: "New answer",
      });
      await user.click(chip);
      expect(jumps).toHaveLength(1);
      expect(scrolled).toHaveLength(0);
      rerender(
        <Thread
          entries={[...first, entry("late", "answer")]}
          onJump={onJump}
        />,
      );
      expect(scrolled).toHaveLength(1);
    } finally {
      Element.prototype.scrollTo = originalScroll;
    }
  });
});
