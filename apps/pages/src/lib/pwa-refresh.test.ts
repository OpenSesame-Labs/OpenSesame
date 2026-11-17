import { afterEach, describe, expect, it, vi } from "vitest";
import { installPwaRefresh, pwaRefreshSeams } from "./pwa-refresh.js";

afterEach(() => vi.restoreAllMocks());

describe("installPwaRefresh", () => {
  it("checks on startup and when the document returns to the foreground", () => {
    const listeners = new Map<string, EventListener>();
    let visibility: DocumentVisibilityState = "hidden";
    const document = {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, listener: EventListener) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    vi.spyOn(pwaRefreshSeams, "host").mockReturnValue({
      document,
      navigator: {
        // SAFETY: installPwaRefresh only checks that a service worker container is present, so an empty object matches the part it reads.
        serviceWorker: {} as ServiceWorkerContainer,
      },
    });
    const check = vi.fn(async () => true);
    const dispose = installPwaRefresh(check);
    expect(check).toHaveBeenCalledTimes(1);
    visibility = "visible";
    listeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(2);
    expect(listeners.has("controllerchange")).toBe(false);
    dispose();
    expect(listeners.size).toBe(0);
  });

  it("does nothing when service workers are unavailable", () => {
    vi.spyOn(pwaRefreshSeams, "host").mockReturnValue({});
    const check = vi.fn(async () => true);
    installPwaRefresh(check)();
    expect(check).not.toHaveBeenCalled();
  });
});
