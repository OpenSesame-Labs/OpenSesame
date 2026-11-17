/** Check for updates when the app returns to the foreground. */
type RefreshHost = {
  document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  navigator?: { serviceWorker?: ServiceWorkerContainer };
};

export const pwaRefreshSeams = {
  host: (): RefreshHost => globalThis,
};

/** The worker controller alone decides whether a changed worker needs a reload. */
export function installPwaRefresh(check: () => Promise<boolean>): () => void {
  const { document, navigator } = pwaRefreshSeams.host();
  if (!document || !navigator?.serviceWorker) return () => undefined;
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  void check();
  return () => document.removeEventListener("visibilitychange", onVisible);
}
