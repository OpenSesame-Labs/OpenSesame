/** Identify the configured local issuer without splitting an IPv6 address. */
export function isLoopbackIssuer(issuer: string): boolean {
  let host: string | undefined;
  try {
    host = new URL(issuer).hostname;
  } catch {
    // Preserve the existing display fallback for malformed operator input.
    [host] = issuer.split(":");
  }
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}
