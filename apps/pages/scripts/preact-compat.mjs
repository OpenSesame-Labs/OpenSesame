import { fileURLToPath } from "node:url";

const reactCompat = fileURLToPath(
  new URL("./preact-react-compat.mjs", import.meta.url),
);

/**
 * Production uses the client-only Preact compatibility renderer. Tests keep
 * React itself: Testing Library is externalized by Vitest and would otherwise
 * render Preact elements through an unaliased React DOM copy, testing a mixed
 * runtime that production never ships.
 */
export const PREACT_COMPAT_ALIASES = Object.freeze({
  // Subpaths precede their bare packages because Vite matches in order.
  "react-dom/test-utils": "preact/test-utils",
  "react-dom/client": "preact/compat/client",
  "react-dom": "preact/compat",
  "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
  "react/jsx-runtime": "preact/jsx-runtime",
  react: reactCompat,
});

export function preactCompat() {
  return {
    name: "opensesame-preact-compat",
    apply: "build",
    config(config) {
      config.resolve ??= {};
      const existing = config.resolve.alias ?? {};
      if (Array.isArray(existing)) {
        config.resolve.alias = [
          ...Object.entries(PREACT_COMPAT_ALIASES).map(
            ([find, replacement]) => ({ find, replacement }),
          ),
          ...existing,
        ];
      } else {
        config.resolve.alias = { ...PREACT_COMPAT_ALIASES, ...existing };
      }
    },
  };
}
