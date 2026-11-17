/**
 * Installs the browser host before any part of the shared core runs
 * (ADR 0133). main.tsx imports this module first, so module evaluation order
 * guarantees the host exists before the app's own modules load.
 *
 * The env is spelled out key by key. Vite inlines `import.meta.env` whole when
 * the object itself is referenced, which would put every `VITE_*` variable in
 * the build environment into the public bundle; naming each key inlines only
 * the ones the core reads.
 */
import "@opensesame/app-core/lib/zod-jitless.js";
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { shellBuild } from "./shell-build.js";

configureHost(
  composeHost(browserPorts(), {
    env: {
      BASE_URL: import.meta.env.BASE_URL,
      DEV: import.meta.env.DEV,
      VITE_CONNECT_CALLBACK_BASE: import.meta.env.VITE_CONNECT_CALLBACK_BASE,
      VITE_DAEMON_API: import.meta.env.VITE_DAEMON_API,
      VITE_HOST_API: import.meta.env.VITE_HOST_API,
      VITE_IDENTITY_API: import.meta.env.VITE_IDENTITY_API,
      VITE_SUPPORT_AGENT_URL: import.meta.env.VITE_SUPPORT_AGENT_URL,
      // Same key-by-key stamp as the flags above. The delay is named only
      // when DEV or the verify flag is on, so Vite drops that read from a
      // default production bundle (a leaked VITE_VERIFY_ACTIVATION_DELAY_MS
      // must not stall activation).
      VITE_VERIFY_ACTIVATION_STALL: import.meta.env
        .VITE_VERIFY_ACTIVATION_STALL,
      VITE_VERIFY_ACTIVATION_DELAY_MS:
        import.meta.env.DEV === true ||
        import.meta.env.VITE_VERIFY_ACTIVATION_STALL === "1" ||
        import.meta.env.VITE_VERIFY_ACTIVATION_STALL === "true"
          ? import.meta.env.VITE_VERIFY_ACTIVATION_DELAY_MS
          : undefined,
    },
    ...shellBuild,
  }),
);
// Start loading the at-rest key (ADR 0149) now: every stored value is sealed
// under it, and boot waits for it before reading anything. A write made
// before it lands waits in memory.
void atRestReady();
