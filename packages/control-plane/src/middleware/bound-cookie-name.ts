/** Each browser session has its own HttpOnly cookie; names never carry tokens. */
export function boundCookieName(base: string, sessionId: string): string {
  return `${base}_bound_${sessionId}`;
}

export function validBoundSessionId(value: string): boolean {
  return /^ps_[A-Za-z0-9_-]{1,160}$/u.test(value);
}

/** Cookie paths are seen by the browser before a reverse proxy strips a prefix. */
export function boundCookiePath(publicUrl: string): string {
  try {
    return `${new URL(publicUrl).pathname.replace(/\/+$/u, "")}/v1/bound/`;
  } catch {
    return "/v1/bound/";
  }
}

export function boundCookieSameSite(publicUrl: string): "None" | "Lax" {
  return publicUrl.startsWith("https://") ? "None" : "Lax";
}
