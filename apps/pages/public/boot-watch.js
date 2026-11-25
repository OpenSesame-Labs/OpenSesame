// A module that fails to download never reaches main.tsx's bootstrap catch.
// Retry the entry graph once for a temporary network failure. The marker must
// survive navigation, or an unavailable asset would reload forever.
const bootRetryKey = "os-entry-load-retry";

function retryEntry() {
  try {
    if (sessionStorage.getItem(bootRetryKey)) return false;
    sessionStorage.setItem(bootRetryKey, "1");
    if (sessionStorage.getItem(bootRetryKey) !== "1") return false;
    location.reload();
    return true;
  } catch {
    // Without tab storage a reload cannot be bounded.
    return false;
  }
}

// Once the application has replaced the startup placeholder, a later visit
// in this tab may get its own retry. The placeholder's status changes do not
// count as a successful start.
function watchForStart() {
  const root = document.getElementById("root");
  if (!root) return;
  const clearAfterStart = () => {
    if (!root.hasChildNodes() || root.querySelector(".boot")) return;
    observer.disconnect();
    try {
      sessionStorage.removeItem(bootRetryKey);
    } catch {
      // Storage may be disabled; the application has already started.
    }
  };
  const observer = new MutationObserver(clearAfterStart);
  observer.observe(root, { childList: true, subtree: true });
  clearAfterStart();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", watchForStart, { once: true });
} else watchForStart();

window.addEventListener(
  "error",
  (event) => {
    const script = event.target;
    if (!(script instanceof HTMLScriptElement) || script.type !== "module")
      return;
    const path = new URL(script.src, location.href).pathname;
    if (!/\/(?:assets\/main-[\w-]+\.js|src\/main\.tsx)$/.test(path)) return;
    if (retryEntry()) return;
    const showError = () => {
      const status = document.querySelector(".boot__status");
      if (!status) return;
      status.textContent = "OpenSesame could not start.";
      status.setAttribute("role", "alert");
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showError, { once: true });
    } else showError();
  },
  true,
);
