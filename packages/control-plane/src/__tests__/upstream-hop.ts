import { overlapCast } from "@opensesame/os-domain";

/** Minimal cookie jar for protocol tests that follow more than one hop. */
export class TestCookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies]
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
    };
  }
}

export async function requestWithJar(
  base: string,
  jar: TestCookieJar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const response = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...jar.header(), ...overlapCast(init.headers) },
  });
  jar.absorb(response);
  return response;
}

/**
 * Read the continuation URL out of the interstitial hop page.
 *
 * A federated/oauth2/SAML start — and the login/consent finishers — answer a
 * form POST with a 200 meta-refresh page instead of a 303: Chromium enforces
 * CSP `form-action 'self'` against every redirect of a form submission, so a
 * chain that leaves this origin would be silently refused in real browsers
 * (see renderHopPage). Tests that used to follow the Location header follow
 * the refresh target instead.
 */
export async function hopUrl(res: Response): Promise<string> {
  if (res.status !== 200) {
    throw new Error(`expected interstitial hop page, got ${res.status}`);
  }
  const html = await res.text();
  const match = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
  if (!match?.[1]) {
    throw new Error("hop page carries no refresh target");
  }
  // `&amp;` decodes last, or an escaped `&amp;lt;` would double-decode.
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
