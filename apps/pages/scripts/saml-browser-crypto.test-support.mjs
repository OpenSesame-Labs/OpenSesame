import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function pendingSamlRequest() {
  const now = Date.now();
  return {
    requestId: "_request",
    issuedAt: now,
    expiresAt: now + 60000,
    issuer: "urn:adapter:idp",
    audience: "urn:adapter:sp",
    acsUrl: "https://app.example/callback",
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    forceAuthentication: true,
    authnContext:
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  };
}

/** Remove the adapter's initialization only in a deliberate fault build. */
export function omitSamlReflection(adapterPath) {
  return {
    name: "saml-no-reflect-negative-control",
    enforce: "pre",
    transform(source, id) {
      if (id.replaceAll("\\", "/") !== adapterPath) return null;
      const marker = 'import "reflect-metadata";';
      if (!source.includes(marker)) throw new Error("Missing mutation site");
      return { code: source.replace(marker, ""), map: null };
    },
  };
}

/** Verify an independently signed response without a preloaded Reflect polyfill. */
export function verifyInCleanRuntime(root, bundlePath, signed, spki) {
  const source = `
    if (typeof Reflect.getMetadata !== "undefined") throw new Error("Reflect was already initialized");
    const { JSDOM } = await import("jsdom");
    const { readFileSync } = await import("node:fs");
    const { webcrypto } = await import("node:crypto");
    const fixture = JSON.parse(readFileSync(0, "utf8"));
    const dom = new JSDOM("<!doctype html><html></html>");
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    for (const name of ["window", "self", "document", "DOMParser", "XMLSerializer", "Node", "NodeFilter", "XPathResult", "Event", "CustomEvent"]) {
      Object.defineProperty(globalThis, name, { value: name === "self" ? dom.window : dom.window[name], configurable: true });
    }
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    if (typeof Reflect.getMetadata !== "undefined") throw new Error("The test setup initialized Reflect");
    const api = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
    const owner = { signal: new AbortController().signal, assertCurrent() {} };
    const proof = await api.verifySamlXmlSignature(fixture.signed, [new Uint8Array(fixture.spki)], owner);
    if (!api.consumeSamlSignatureProof(proof).responseSigned) throw new Error("Signed response was not verified");
    if (typeof Reflect.getMetadata !== "function") throw new Error("SAML did not initialize Reflect");
    dom.window.close();
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    stdio: "pipe",
    input: JSON.stringify({ signed, spki: Array.from(spki) }),
  });
}
