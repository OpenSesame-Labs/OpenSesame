import { normalizeHttpBaseUrl } from "./index.js";

/** An in-process service stub with an explicit origin and fetch transport. */
export interface StubFetchService {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
}

/**
 * Compose distinct service origins into one fetch implementation. The
 * returned function owns no services and never falls back to network fetch.
 */
export function composeStubFetch(
  ...services: StubFetchService[]
): typeof fetch {
  const origins = new Map<string, typeof fetch>();
  for (const service of services) {
    const baseUrl = normalizeHttpBaseUrl(service.baseUrl);
    if (baseUrl === null) throw new Error("invalid_stub_origin");
    const origin = new URL(baseUrl).origin;
    if (origins.has(origin)) throw new Error("duplicate_stub_origin");
    origins.set(origin, service.fetchImpl.bind(service));
  }

  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const serviceFetch = origins.get(new URL(request.url).origin);
    if (!serviceFetch) throw new Error("unhandled_stub_origin");
    return serviceFetch(request);
  };
}
