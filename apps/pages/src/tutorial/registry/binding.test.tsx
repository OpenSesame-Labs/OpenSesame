import {
  duplicateGuideTargetMounts,
  isKnownGuideTarget,
  isMountedGuideTarget,
  isVisibleGuideTarget,
  mountGuideTarget,
  observeGuideTarget,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { GUIDE_LANG_VERSION } from "@opensesame/guide-lang";
import {
  TOUR_APPEAR_GRACE_MS,
  createFakeRoutes,
  createFakeState,
  createGuideRuntime,
  createTestClock,
} from "@opensesame/guide-runtime";
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScrollRenderer } from "../coach/scroll-renderer.js";
import { useGuideTarget } from "./react.jsx";

/**
 * Binding has to follow the element, not the component that renders it.
 *
 * These are the two shapes the app actually contains: a control inside a panel
 * that opens later, and a control that swaps between two mutually exclusive
 * branches. An effect keyed on the id reads `ref.current` once, so both used to
 * leave the registry describing something other than what is on screen.
 */
describe("a target whose element arrives after its component", () => {
  afterEach(cleanup);

  function Deferred() {
    const [open, setOpen] = useState(false);
    const ref = useGuideTarget<HTMLButtonElement>("shell.notifications");
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open ? (
          <button type="button" ref={ref}>
            health
          </button>
        ) : null}
      </div>
    );
  }

  it("registers when the panel holding it finally opens", () => {
    const { getByText } = render(<Deferred />);
    expect(isMountedGuideTarget("shell.notifications")).toBe(false);

    fireEvent.click(getByText("open"));

    expect(isMountedGuideTarget("shell.notifications")).toBe(true);
    expect(resolveGuideTargetElement("shell.notifications")?.textContent).toBe(
      "health",
    );
  });

  function Swapping() {
    const [empty, setEmpty] = useState(true);
    const ref = useGuideTarget<HTMLButtonElement>("vault.create");
    return (
      <div>
        <button type="button" onClick={() => setEmpty(false)}>
          fill
        </button>
        {/* Distinct keys, so React really does discard one node and build the
            other — the two "new item" affordances in VaultSection live in
            different parents, and reusing one node here would test nothing. */}
        {empty ? (
          <div key="empty">
            <button type="button" ref={ref}>
              empty-state
            </button>
          </div>
        ) : (
          <section key="list">
            <button type="button" ref={ref}>
              list-header
            </button>
          </section>
        )}
      </div>
    );
  }

  it("follows a control that swaps between two branches", () => {
    const { getByText } = render(<Swapping />);
    expect(resolveGuideTargetElement("vault.create")?.textContent).toBe(
      "empty-state",
    );

    fireEvent.click(getByText("fill"));

    // The old node is gone from the document; the registry must not still be
    // holding it, or the walkthrough points at nothing.
    expect(resolveGuideTargetElement("vault.create")?.textContent).toBe(
      "list-header",
    );
    expect(resolveGuideTargetElement("vault.create")?.isConnected).toBe(true);
    expect(duplicateGuideTargetMounts()).toEqual([]);
  });

  it("unregisters when the element leaves", () => {
    const { unmount } = render(<Deferred />);
    unmount();
    expect(isMountedGuideTarget("shell.notifications")).toBe(false);
  });
});

describe("waiting for a target to appear", () => {
  afterEach(cleanup);

  /**
   * `appear` asks the same question `focus` does. A wait satisfied by mere
   * registration would resolve on the copy a media query has hidden, and hand
   * the next instruction a control nobody can see.
   *
   * This is the responsive shell in miniature: the phone chip and the desktop
   * rail row both register the same id, one of them hidden by a media query.
   * The wait must ignore the hidden candidate and settle only once a candidate
   * somebody can actually see is mounted.
   */
  it("ignores a hidden candidate and settles on a visible one", async () => {
    const hiddenHolder = document.createElement("div");
    hiddenHolder.style.display = "none";
    document.body.append(hiddenHolder);

    function Chip() {
      const ref = useGuideTarget<HTMLButtonElement>("vault.filter.logins");
      return (
        <button type="button" ref={ref}>
          hidden-chip
        </button>
      );
    }
    render(<Chip />, { container: hiddenHolder });
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(false);

    const controller = new AbortController();
    let settled = false;
    const waiting = observeGuideTarget(
      "vault.filter.logins",
      "appear",
      controller.signal,
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    // The visible copy mounts, which is what announces to the registry.
    function RailRow() {
      const ref = useGuideTarget<HTMLButtonElement>("vault.filter.logins");
      return (
        <button type="button" ref={ref}>
          visible-row
        </button>
      );
    }
    render(<RailRow />);
    // jsdom lays nothing out, so stub the box a visible control reports; the
    // appear wait settles on `visibleTargetRect`, not on the resolver's
    // pointable-element fallback.
    vi.spyOn(
      screen.getByText("visible-row"),
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 120, 40));

    await waiting;
    expect(settled).toBe(true);
    expect(resolveGuideTargetElement("vault.filter.logins")?.textContent).toBe(
      "visible-row",
    );

    controller.abort();
    hiddenHolder.remove();
  });
});

function createBoundRuntime(clock: ReturnType<typeof createTestClock>) {
  return createGuideRuntime({
    targets: {
      isKnown: isKnownGuideTarget,
      isMounted: isMountedGuideTarget,
      isVisible: isVisibleGuideTarget,
      observe: observeGuideTarget,
    },
    routes: createFakeRoutes(["/vault"], "/vault"),
    state: createFakeState([]),
    renderer: createScrollRenderer({
      resolveElement: resolveGuideTargetElement,
    }),
    clock,
  });
}

it.each([false, true])(
  "reveals a late offscreen focus target (after grace: %s)",
  async (afterGrace) => {
    const clock = createTestClock();
    const runtime = createBoundRuntime(clock);
    void runtime.start(
      {
        version: GUIDE_LANG_VERSION,
        goal: "vault.item.create",
        instructions: [
          {
            kind: "focus",
            target: "vault.import",
            message: "Import items.",
            side: null,
          },
          { kind: "end" },
        ],
      },
      { mode: "tour" },
    );
    await clock.advance(0);
    if (afterGrace) {
      await clock.advance(TOUR_APPEAR_GRACE_MS);
      expect(runtime.snapshot().tour?.degraded).toBe(true);
    }
    const hidden = document.createElement("button");
    hidden.style.display = "none";
    hidden.getBoundingClientRect = () => new DOMRect(10, 10, 44, 44);
    hidden.scrollIntoView = vi.fn();
    document.body.append(hidden);
    const detachHidden = mountGuideTarget("vault.import", hidden);
    await clock.advance(0);
    expect(hidden.scrollIntoView).not.toHaveBeenCalled();
    const element = document.createElement("button");
    let top = 2_000;
    element.getBoundingClientRect = () => new DOMRect(10, top, 44, 44);
    element.scrollIntoView = vi.fn(() => {
      top = 10;
    });
    document.body.append(element);
    const detach = mountGuideTarget("vault.import", element);
    await clock.advance(0);

    // One reveal, then the focus renderer's normal centering.
    expect(element.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().tour).toMatchObject({
      target: "vault.import",
      degraded: false,
    });
    runtime.cancel("navigation");
    detach();
    detachHidden();
    element.remove();
    hidden.remove();
  },
);

it.each([
  [true, false],
  [false, false],
  [true, true],
])(
  "reveals the next target: %s, with a clipped candidate already mounted: %s",
  async (sameTarget, initiallyClipped) => {
    const clock = createTestClock();
    const runtime = createBoundRuntime(clock);
    const opener = document.createElement("button");
    opener.getBoundingClientRect = () => new DOMRect(10, 10, 44, 44);
    opener.scrollIntoView = vi.fn();
    document.body.append(opener);
    const detachOpener = mountGuideTarget("vault.create", opener);
    const appeared = document.createElement("button");
    let top = 2_000;
    appeared.getBoundingClientRect = () => new DOMRect(10, top, 44, 44);
    appeared.scrollIntoView = vi.fn(() => {
      top = 10;
    });
    document.body.append(appeared);
    let detachAppeared = () => {};
    let detachEmpty = () => {};
    let detachClipped = () => {};
    const empty = document.createElement("button");
    empty.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    empty.scrollIntoView = vi.fn();
    document.body.append(empty);
    const clip = document.createElement("div");
    clip.style.overflow = "hidden";
    clip.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    Object.defineProperties(clip, {
      clientWidth: { value: 100 },
      clientHeight: { value: 50 },
    });
    const clipped = document.createElement("button");
    clipped.getBoundingClientRect = () => new DOMRect(10, 100, 44, 44);
    clipped.scrollIntoView = vi.fn();
    clip.append(clipped);
    document.body.append(clip);
    try {
      if (initiallyClipped) {
        detachEmpty = mountGuideTarget("vault.import", empty);
        detachClipped = mountGuideTarget("vault.import", clipped);
      }
      void runtime.start(
        {
          version: GUIDE_LANG_VERSION,
          goal: "vault.item.create",
          instructions: [
            {
              kind: "focus",
              target: "vault.create",
              message: "Open.",
              side: null,
            },
            {
              kind: "wait",
              subject: "target",
              target: "vault.import",
              event: "appear",
              timeoutMs: 30_000,
            },
            {
              kind: "focus",
              target: sameTarget ? "vault.import" : "vault.export",
              message: "Continue.",
              side: null,
            },
            { kind: "end" },
          ],
        },
        { mode: "tour" },
      );
      await clock.advance(0);
      expect(runtime.snapshot().tour).toMatchObject({
        target: "vault.create",
        action: true,
      });
      if (!initiallyClipped) {
        detachEmpty = mountGuideTarget("vault.import", empty);
        detachClipped = mountGuideTarget("vault.import", clipped);
      }
      await clock.advance(0);
      expect(empty.scrollIntoView).not.toHaveBeenCalled();
      expect(runtime.snapshot().tour?.target).toBe("vault.create");
      detachAppeared = mountGuideTarget("vault.import", appeared);
      await clock.advance(0);
      if (sameTarget) {
        expect(appeared.scrollIntoView).toHaveBeenCalled();
        expect(runtime.snapshot().tour?.target).toBe("vault.import");
        expect(clipped.scrollIntoView).toHaveBeenCalledOnce();
      } else {
        expect(appeared.scrollIntoView).not.toHaveBeenCalled();
        expect(runtime.snapshot().tour?.target).toBe("vault.create");
        top = 10;
        await new Promise((resolve) => setTimeout(resolve, 120));
        await clock.advance(0);
        expect(runtime.snapshot().tour?.target).toBe("vault.export");
      }
    } finally {
      runtime.cancel("navigation");
      detachAppeared();
      detachClipped();
      detachEmpty();
      detachOpener();
      appeared.remove();
      empty.remove();
      clip.remove();
      opener.remove();
    }
  },
);
