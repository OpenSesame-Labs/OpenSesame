import { createHash, randomBytes } from "node:crypto";

export function firstPartyMagicRequest(email: string, origin: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  return {
    verifier,
    state,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email,
        callbackURL: `${origin}/opensesame/callback`,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        state,
      }),
    },
  };
}

export function confirmFirstPartyMagicLink(link: URL, identity = link.origin) {
  return fetch(`${identity}${link.pathname}`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams(link.hash.slice(1)),
  });
}

export function exchangeFirstPartyMagicLink(
  identity: string,
  location: string,
  verifier: string,
  state: string,
  origin: string,
) {
  const callback = new URL(location);
  return fetch(`${identity}/v1/auth/magic-link/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      code: callback.searchParams.get("magic_code"),
      codeVerifier: verifier,
      state,
    }),
  });
}
