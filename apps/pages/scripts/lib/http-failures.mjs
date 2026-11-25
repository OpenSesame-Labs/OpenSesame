/** Admit only the expected navigations and console errors for an SPA fallback. */
export function observeHttpFailures(
  page,
  record,
  expectedFallbackUrl,
  limit = 1,
) {
  let fallbackObserved = 0;
  let fallbackConsoleObserved = 0;
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    if (
      response.status() === 404 &&
      response.url() === expectedFallbackUrl &&
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      request.frame() === page.mainFrame() &&
      fallbackObserved < limit
    ) {
      fallbackObserved += 1;
      record("EXPECTED-FALLBACK", response.url());
      return;
    }
    record("HTTP-ERROR", `${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      fallbackConsoleObserved < fallbackObserved &&
      message.location().url === expectedFallbackUrl &&
      message.text() ===
        "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ) {
      fallbackConsoleObserved += 1;
      record("EXPECTED-FALLBACK-CONSOLE", expectedFallbackUrl);
      return;
    }
    record("console-error", message.text().slice(0, 400));
  });
}
