import { createHash, randomBytes } from "node:crypto";
import type { ReferenceIdp } from "@opensesame/mock-upstream-idp/testkit";
import { isString, overlapCast } from "@opensesame/os-domain";

export async function mintOrgIdToken(origin: string, idp: ReferenceIdp) {
  const clientId = `origin:${origin}`;
  const redirectUri = `${origin}/opensesame/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${idp.issuer}/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  const redirected = await fetch(authorize, { redirect: "manual" });
  const code =
    new URL(redirected.headers.get("location") ?? "").searchParams.get(
      "code",
    ) ?? "";
  const tokens = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const idToken = overlapCast(await tokens.json()).id_token;
  if (!isString(idToken)) throw new Error("no id_token minted");
  const [, payload] = idToken.split(".");
  const claims = overlapCast(
    JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
  );
  const subject = claims.pairwise_sub ?? claims.sub;
  if (!isString(subject)) throw new Error("no subject in id_token");
  return { idToken, subject };
}
