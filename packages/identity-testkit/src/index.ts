import { randomBytes } from "node:crypto";
import { startServer } from "@opensesame/control-plane";
import type { Clock } from "@opensesame/os-domain";
import { onFreePort } from "@opensesame/testing/ports";
import { assertIdentityTestEnvironment } from "./environment.js";

export interface IdentityTestServerOptions {
  /** An injected application clock for expiry tests. */
  clock?: Clock;
}

export interface IdentityTestServer {
  /** The real Identity API and OIDC issuer, listening on loopback. */
  baseUrl: string;
  /** Stop the listener and discard its in-memory state. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Start an isolated copy of the real Identity HTTP service for tests.
 *
 * Application configuration is built from scratch: a host database, configured
 * upstream providers and test-only principal-bearer shortcuts are not inherited.
 * The AgentAuth runtime remains process-global; see the package README. Use a
 * separate instance for each test and close it in a finally block.
 */
export async function startIdentityTestServer(
  options: IdentityTestServerOptions = {},
): Promise<IdentityTestServer> {
  assertIdentityTestEnvironment(process.env);
  const claimPepper = randomBytes(32).toString("base64url");
  const started = await onFreePort((port) => {
    const baseUrl = `http://127.0.0.1:${port}`;
    return startServer({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: baseUrl,
        issuer: baseUrl,
        hostApiUrl: "http://127.0.0.1:0",
        logLevel: "silent",
      },
      processEnv: {
        NODE_ENV: "test",
        OPENSESAME_CLAIM_PEPPER: claimPepper,
      },
      ...(options.clock ? { clock: options.clock } : undefined),
    });
  });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  let closing: Promise<void> | undefined;
  return {
    baseUrl,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
        started.server.closeAllConnections();
      });
      return closing;
    },
  };
}
