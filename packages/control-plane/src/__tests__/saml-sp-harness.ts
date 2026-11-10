import { overlapCast } from "@opensesame/os-domain";
import { startServer } from "../server.js";
import { hopUrl } from "./upstream-hop.js";

/** HTTP-level helpers for the native SAML SP suites. */

export type Started = Awaited<ReturnType<typeof startServer>>;
type PostBindingForm = { action: string; fields: AcsFormFields };
/** Exactly what the IdP's POST-binding form carries to the ACS. */
type AcsFormFields = { SAMLResponse?: string; RelayState?: string };
type LoginPage = { jar: Jar; uid: string; html: string };
type StartedSamlLeg = { jar: Jar; uid: string; binding: PostBindingForm };

const RP_ORIGIN = "http://127.0.0.1:4331";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

/** Minimal cookie jar: a superset of browser path-scoping, fine for tests. */
export class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
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
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

export async function startControlPlane(
  upstreamIssuer: string,
  port: number,
): Promise<Started> {
  return startServer({
    config: {
      host: "127.0.0.1",
      port,
      // publicUrl must match the real bound port: it is the SP entityID, the
      // ACS the AuthnRequest names, and the origin-profile client id.
      publicUrl: `http://127.0.0.1:${port}`,
      issuer: `http://127.0.0.1:${port}`,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
      OPENSESAME_TRUSTED_UPSTREAMS: upstreamIssuer,
    },
  });
}

export function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

export async function req(
  base: string,
  jar: Jar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...jar.header(), ...overlapCast(init.headers) },
  });
  jar.absorb(res);
  return res;
}

/** The hidden inputs of the IdP's HTTP-POST binding document. */
function parsePostBinding(html: string): PostBindingForm {
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "";
  const fields: AcsFormFields = {};
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    const value = input[0].match(/value="([^"]*)"/)?.[1];
    if (name === "SAMLResponse") fields.SAMLResponse = decodeHtml(value ?? "");
    if (name === "RelayState") fields.RelayState = decodeHtml(value ?? "");
  }
  return { action, fields };
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export async function openLoginPage(base: string): Promise<LoginPage> {
  const jar = new Jar();
  const res = await req(
    base,
    jar,
    `/auth?${new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString()}`,
  );
  const location = res.headers.get("location") ?? "";
  const page = await req(base, jar, location);
  return {
    jar,
    uid: location.slice("/interaction/".length),
    html: await page.text(),
  };
}

/**
 * Drive an SP-initiated leg up to (but not through) the ACS.
 *
 * Returns what the IdP would have made the browser POST, so the caller can
 * decide how to deliver it — which is the point of separating this out: the
 * ACS POST in a real flow carries no cookies at all (T25).
 */
export async function runSamlLegToPostBinding(
  base: string,
  slug: string,
): Promise<StartedSamlLeg> {
  const { jar, uid, html } = await openLoginPage(base);
  const start = await req(base, jar, `/interaction/${uid}/federated/saml`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: extractCsrf(html), slug }),
  });
  const authnRequestUrl = await hopUrl(start);
  const idpRes = await fetch(authnRequestUrl, { redirect: "manual" });
  return { jar, uid, binding: parsePostBinding(await idpRes.text()) };
}

/** Post an assertion to the ACS the way a browser does: with NO cookies (T25). */
export async function postAcsCookieless(
  acsUrl: string,
  fields: AcsFormFields,
): Promise<Response> {
  const body = new URLSearchParams({ SAMLResponse: fields.SAMLResponse ?? "" });
  if (fields.RelayState !== undefined)
    body.set("RelayState", fields.RelayState);
  return fetch(acsUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}
