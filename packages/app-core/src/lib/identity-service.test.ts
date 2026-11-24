import { afterEach, describe, expect, it } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import {
  normalizeSignInService,
  signInServiceIsDeployed,
} from "./identity-service.js";
import { applyRuntimeConfig } from "./settings.js";

describe("normalizeSignInService", () => {
  it("keeps an https address without its trailing slash", () => {
    expect(normalizeSignInService(" https://login.example.com/ ")).toBe(
      "https://login.example.com",
    );
    expect(normalizeSignInService("https://example.com/identity/")).toBe(
      "https://example.com/identity",
    );
  });

  it("allows http only on this machine", () => {
    expect(normalizeSignInService("http://127.0.0.1:8788")).toBe(
      "http://127.0.0.1:8788",
    );
    expect(normalizeSignInService("http://localhost:8788/")).toBe(
      "http://localhost:8788",
    );
    expect(normalizeSignInService("http://login.example.com")).toBeNull();
  });

  it("refuses what a code may not be requested from", () => {
    for (const bad of [
      "",
      "   ",
      "login.example.com",
      "ftp://login.example.com",
      "javascript:alert(1)",
      "https://user:pass@login.example.com",
      "https://login.example.com/?next=/x",
      "https://login.example.com/#frag",
    ]) {
      expect(normalizeSignInService(bad)).toBeNull();
    }
  });
});

describe("normalizeSignInService trailing slashes", () => {
  it("strips the whole trailing run so requests are not misrouted", () => {
    expect(normalizeSignInService("https://login.example.com///")).toBe(
      "https://login.example.com",
    );
    expect(normalizeSignInService("https://example.com/identity//")).toBe(
      "https://example.com/identity",
    );
  });
});

const realRemoteIdentityApi = deviceIdentitySeams.remoteIdentityApi;

function inUse(address: string): void {
  deviceIdentitySeams.remoteIdentityApi = () => address.replace(/\/+$/, "");
}

describe("signInServiceIsDeployed", () => {
  afterEach(() => {
    deviceIdentitySeams.remoteIdentityApi = realRemoteIdentityApi;
    applyRuntimeConfig({});
  });

  it("is false when the deployment supplies nothing", () => {
    applyRuntimeConfig({});
    inUse("https://login.example.com");
    expect(signInServiceIsDeployed()).toBe(false);
  });

  it("is true when the address in use is the deployment's own, slashes aside", () => {
    applyRuntimeConfig({ identityApi: "https://id.corp.example/" });
    inUse("https://id.corp.example");
    expect(signInServiceIsDeployed()).toBe(true);
  });

  it("is false once a person has set a different address", () => {
    applyRuntimeConfig({ identityApi: "https://id.corp.example" });
    inUse("https://login.example.com");
    expect(signInServiceIsDeployed()).toBe(false);
  });
});
