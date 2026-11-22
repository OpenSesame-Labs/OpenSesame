import { jwtAuthenticator } from "@nats-io/nats-core";
import { createUser } from "@nats-io/nkeys";
import { describe, expect, it, vi } from "vitest";
import { browserJwtAuthenticator } from "./nats-authenticator.js";

const decoder = new TextDecoder();

describe("browser NATS JWT authentication", () => {
  it("matches the official nkeys authenticator byte for byte", () => {
    const pair = createUser();
    const seed = pair.getSeed();
    const jwt = "header.claim.signature";
    const nonce = "server challenge with utf8 ✓";
    const official = jwtAuthenticator(jwt, seed);
    const browser = browserJwtAuthenticator(jwt, decoder.decode(seed));
    expect(browser(nonce)).toEqual(official(nonce));
    expect(browser()).toEqual(official());
  });

  it("rejects corrupted, truncated and non-seed input without logging it", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pair = createUser();
    const seed = decoder.decode(pair.getSeed());
    const corrupted = `${seed.slice(0, 10)}${seed[10] === "A" ? "B" : "A"}${seed.slice(11)}`;
    expect(() => browserJwtAuthenticator("jwt", corrupted)).toThrow(/checksum/);
    expect(() => browserJwtAuthenticator("jwt", seed.slice(0, -4))).toThrow(
      /length/,
    );
    expect(() => browserJwtAuthenticator("jwt", `!${seed.slice(1)}`)).toThrow(
      /encoding/,
    );
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
