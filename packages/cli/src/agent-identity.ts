import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";

/** The public half of a stored agent identity, refused unless both halves are an EC P-256 pair. */
function storedAgentPublicKey(text: string): JsonWebKey {
  const raw: JsonValue = JSON.parse(text);
  const file = readJsonObject(raw);
  const privateJwk = readJsonObject(file?.privateJwk);
  const publicJwk = readJsonObject(file?.publicJwk);
  const x = readString(publicJwk?.x);
  const y = readString(publicJwk?.y);
  if (
    privateJwk?.d === undefined ||
    publicJwk?.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    !x ||
    !y
  )
    throw new Error("Agent identity file is invalid.");
  return { crv: "P-256", kty: "EC", x, y };
}

/**
 * The agent's public-key thumbprint is an identity, not a random label. Keep
 * the private half in the CLI state directory so the same agent can prove
 * possession when a person claims it, and reuse it across `agent init` runs.
 */
export async function agentPublicKeyThumbprint(): Promise<string> {
  const base =
    process.env.OPENSESAME_STATE_DIR ??
    process.env.XDG_RUNTIME_DIR ??
    join(homedir(), ".config", "opensesame");
  const path = join(base, "agent-identity.json");
  const thumbprint = (jwk: JsonWebKey): string =>
    createHash("sha256")
      .update(
        JSON.stringify({
          crv: jwk.crv,
          kty: jwk.kty,
          x: jwk.x,
          y: jwk.y,
        }),
      )
      .digest("base64url");

  try {
    return thumbprint(storedAgentPublicKey(await readFile(path, "utf8")));
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  await mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify({ v: 1, publicJwk, privateJwk }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return agentPublicKeyThumbprint();
    }
    throw error;
  }
  return thumbprint(publicJwk);
}
