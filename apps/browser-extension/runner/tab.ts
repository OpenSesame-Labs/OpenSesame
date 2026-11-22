/**
 * One tab, and what the runner does inside it.
 *
 * Every injection goes through `injectorFor`, which refuses to run anything in a
 * tab that is not on the run's origin; a click is never retried.
 */
import { originOf } from "./origin";
import { pfSubmit } from "./page-fns";
import type { Capture } from "./ports";

export interface Tab {
  tabId: number;
  /** Close whatever owns the tab: the tab itself, or its private window. */
  dispose: () => Promise<void>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the next load of `tabId` to finish, or `ms` to pass. */
export function loaded(tabId: number, ms: number, start: () => Promise<void>) {
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    browser.tabs.onUpdated.addListener(listener);
    start().catch(() => finish(false));
  });
}

/** Wait until `tabId` is not mid-navigation, for at most `ms`. */
async function quiet(tabId: number, ms: number): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab?.status !== "loading") return;
  await loaded(tabId, ms, async () => undefined);
}

export interface Injector {
  /** Whether the tab is still on the run's origin. */
  onOrigin(): Promise<boolean>;
  /** Run `func` in the top frame, if the tab is still on the run's origin. */
  inject<A extends unknown[], R>(
    func: (...args: A) => R,
    args: A,
    retries: number,
  ): Promise<Awaited<R>>;
}

export function injectorFor(tabId: number, origin: string): Injector {
  async function onOrigin(): Promise<boolean> {
    try {
      const current = await browser.tabs.get(tabId);
      return originOf(current.url ?? "") === origin;
    } catch {
      return false;
    }
  }

  async function inject<A extends unknown[], R>(
    func: (...args: A) => R,
    args: A,
    retries: number,
  ): Promise<Awaited<R>> {
    for (let attempt = 0; ; attempt += 1) {
      if (!(await onOrigin())) throw new Error("off_origin");
      try {
        const [first] = await browser.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: "ISOLATED",
          func,
          args,
        });
        // SAFETY: executeScript returns what func returned, so its declared type is the contract.
        return first?.result as Awaited<R>;
      } catch (error) {
        // A page that is mid-navigation loses its frame; wait it out and look again.
        if (attempt >= retries) throw error;
        await quiet(tabId, 10_000);
      }
    }
  }

  return { onOrigin, inject };
}

/**
 * Press `selector` once. Never retried: a second click is a second submit. A
 * click that navigates tears the frame down before it can answer, so a frame
 * that vanished while the tab was navigating is read as the click it was.
 */
export async function press(
  tabId: number,
  injector: Injector,
  selector: string,
  origin: string,
) {
  let navigated = false;
  const listener = (id: number, info: { status?: string; url?: string }) => {
    if (id === tabId && (info.status === "loading" || info.url)) {
      navigated = true;
    }
  };
  browser.tabs.onUpdated.addListener(listener);
  try {
    const verdict = await injector.inject(pfSubmit, [selector, origin], 0);
    if (verdict === "off_origin") throw new Error("off_origin");
    return verdict;
  } catch (error) {
    // A navigation observed before the click is not proof that it occurred.
    if (String(error).includes("off_origin")) throw error;
    await delay(500);
    if (navigated) return "ok" as const;
    throw error;
  } finally {
    browser.tabs.onUpdated.removeListener(listener);
  }
}

/**
 * Chromium's visible-tab capture cannot bind pixels to this tab or to the
 * document where masks were installed. Refuse rather than export pixels that
 * might belong to another tab or an unmasked navigation.
 */
export async function stillOf(
  _tabId: number,
  _injector: Injector,
  _maskSelectors: string[],
): Promise<Capture | null | "unsupported"> {
  return "unsupported";
}
