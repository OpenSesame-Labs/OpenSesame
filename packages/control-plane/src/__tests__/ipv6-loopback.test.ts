import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { federatedUpstreams } from "../interactions/federated.js";
import {
  type ProviderDescriptor,
  isBrowserCapable,
  staticProviders,
} from "../interactions/registry.js";

it("labels an IPv6 loopback issuer as a local test account", () => {
  const issuer = "http://[::1]:9090";
  const config = overlapCast({
    trustedUpstreamIssuers: [issuer],
    providers: [],
  });
  expect(federatedUpstreams(config)).toEqual([
    { id: "mock", issuer, label: "a local test account" },
  ]);
});

it("offers the IPv6 loopback public client to the browser", () => {
  const issuer = "http://[::1]:9090";
  const config = overlapCast({
    trustedUpstreamIssuers: [issuer],
    providers: [],
  });
  const [provider] = staticProviders(config);
  expect(provider).toMatchObject({ id: "mock", issuer, clientAuth: "none" });
  if (!provider) throw new Error("Missing synthesized loopback provider");
  expect(isBrowserCapable(provider)).toBe(true);
});

it("does not treat non-loopback hosts or credentialed clients as browser-capable", () => {
  const provider: ProviderDescriptor = {
    id: "test",
    kind: "oidc",
    label: "Test",
    issuer: "http://[::2]:9090",
    scopes: "openid",
    clientAuth: "none",
  };
  expect(isBrowserCapable(provider)).toBe(false);
  expect(
    isBrowserCapable({
      ...provider,
      issuer: "http://localhost.attacker.invalid",
    }),
  ).toBe(false);
  expect(
    isBrowserCapable({
      ...provider,
      issuer: "http://[::1]:9090",
      clientAuth: "client_secret_post",
    }),
  ).toBe(false);
});
