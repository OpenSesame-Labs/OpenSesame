// A module that fails to download never reaches main.tsx's bootstrap catch.
// Listen before the module graph starts so that failure is visible as well.
window.addEventListener(
  "error",
  (event) => {
    const script = event.target;
    if (!(script instanceof HTMLScriptElement) || script.type !== "module")
      return;
    const path = new URL(script.src, location.href).pathname;
    if (!/\/(?:assets\/main-[\w-]+\.js|src\/main\.tsx)$/.test(path)) return;
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
