/**
 * Explicit, in-process HTTP responses for consumers of the Host API client.
 * This is a scripted stub, not an implementation of Host authentication,
 * authorization, persistence, or the gateway's business rules.
 */
import { normalizeHttpBaseUrl } from "./index.js";

export type HostStubHandler = (
  request: Request,
) => Response | Promise<Response>;

export interface HostApiStub {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  /** Match an exact HTTP method and URL pathname, relative to baseUrl. */
  route(method: string, path: string, handler: HostStubHandler): void;
  /** Remove routes and invalidate handlers that have not returned a response. */
  reset(): void;
  /** Dispose of the stub; it cannot be restarted after this call. */
  close(): Promise<void>;
}

function untilCanceled<T>(
  promise: Promise<T>,
  signals: readonly AbortSignal[],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const listeners: { signal: AbortSignal; abort: () => void }[] = [];
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      for (const listener of listeners) {
        listener.signal.removeEventListener("abort", listener.abort);
      }
      action();
    };
    for (const signal of signals) {
      if (settled) break;
      const abort = () => finish(() => reject(signal.reason));
      listeners.push({ signal, abort });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    // Keep both reactions attached even if a signal wins the race, so a
    // handler that rejects later cannot become an unhandled rejection.
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Never opens a port or falls back to the network for unknown requests. */
export function createHostApiStub(
  requestedBaseUrl = "http://127.0.0.1:8787",
): HostApiStub {
  const baseUrl = normalizeHttpBaseUrl(requestedBaseUrl);
  if (baseUrl === null) throw new Error("invalid_host_stub_base_url");
  const base = new URL(baseUrl);
  const basePath = base.pathname === "/" ? "" : base.pathname;
  const routes = new Map<string, HostStubHandler>();
  let closed = false;
  let generation = 0;
  let lifecycle = new AbortController();

  function requireOpen(): void {
    if (closed) throw new Error("host_stub_closed");
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    requireOpen();
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.origin !== base.origin) throw new Error("host_stub_foreign_origin");
    const handler = routes.get(`${request.method} ${url.pathname}`);
    if (!handler) throw new Error("unhandled_host_stub_request");
    const started = generation;
    const lifecycleSignal = lifecycle.signal;
    const result = Promise.resolve().then(() => {
      request.signal.throwIfAborted();
      lifecycleSignal.throwIfAborted();
      return handler(request);
    });
    const response = await untilCanceled(result, [
      request.signal,
      lifecycleSignal,
    ]);
    // A handler from the previous test must not complete into the next one.
    if (started !== generation)
      throw new Error("host_stub_request_invalidated");
    request.signal.throwIfAborted();
    return response;
  };

  return {
    baseUrl,
    fetchImpl,
    route(method, path, handler) {
      requireOpen();
      const normalizedMethod = method.toUpperCase();
      if (
        !/^[A-Z]+$/.test(normalizedMethod) ||
        !path.startsWith("/") ||
        path.includes("?") ||
        path.includes("#") ||
        new URL(`${base.origin}${path}`).pathname !== path
      ) {
        throw new Error("invalid_host_stub_route");
      }
      const key = `${normalizedMethod} ${basePath}${path}`;
      if (routes.has(key)) throw new Error("duplicate_host_stub_route");
      routes.set(key, handler);
    },
    reset() {
      requireOpen();
      generation += 1;
      routes.clear();
      const previous = lifecycle;
      lifecycle = new AbortController();
      previous.abort(new Error("host_stub_request_invalidated"));
    },
    async close() {
      if (closed) return;
      closed = true;
      generation += 1;
      routes.clear();
      lifecycle.abort(new Error("host_stub_request_invalidated"));
    },
  };
}
