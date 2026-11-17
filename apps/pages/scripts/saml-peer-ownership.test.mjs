/** The SAML SDK and parser must resolve their declared peers from a clean install. */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = process.cwd().endsWith("/apps/pages")
  ? resolve(process.cwd(), "../..")
  : process.cwd();
const core = createRequire(resolve(root, "packages/app-core/package.json"));
const workspace = createRequire(resolve(root, "package.json"));

function version(owner, name) {
  return JSON.parse(readFileSync(owner.resolve(`${name}/package.json`), "utf8"))
    .version;
}

it("resolves each XML signature peer at its pinned compatible version", () => {
  const sdk = createRequire(core.resolve("xmldsigjs"));
  expect(version(sdk, "xml-core")).toBe("3.0.0");
  expect(version(sdk, "asn1js")).toBe("4.0.0");
  expect(version(sdk, "pkijs")).toBe("4.0.1");
});

it("shares the certificate parser and ASN.1 registry with WebAuthn", () => {
  const schema = realpathSync(workspace.resolve("@peculiar/asn1-schema"));
  expect(version(workspace, "@peculiar/asn1-schema")).toBe("2.11.1");
  expect(schema).not.toBe(realpathSync(core.resolve("@peculiar/asn1-schema")));
  expect(version(core, "@peculiar/x509")).toBe("1.14.3");
  expect(realpathSync(core.resolve("@peculiar/x509"))).toBe(
    realpathSync(workspace.resolve("@peculiar/x509")),
  );
  const upstream = createRequire(
    resolve(root, "packages/auth-upstream/package.json"),
  );
  expect(version(upstream, "asn1js")).toBe("3.1.0");
  expect(realpathSync(upstream.resolve("asn1js"))).toBe(
    realpathSync(
      createRequire(core.resolve("@peculiar/x509")).resolve("asn1js"),
    ),
  );
  for (const name of [
    "@simplewebauthn/server",
    "@peculiar/x509",
    "@peculiar/asn1-rsa",
    "@peculiar/asn1-x509",
    "@peculiar/asn1-ecc",
  ]) {
    const owner = createRequire(workspace.resolve(name));
    expect(realpathSync(owner.resolve("@peculiar/asn1-schema")), name).toBe(
      schema,
    );
    expect(version(owner, "asn1js"), name).toBe("3.1.0");
  }
});
