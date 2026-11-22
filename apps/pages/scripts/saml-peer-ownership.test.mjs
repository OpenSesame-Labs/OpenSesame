/** The SAML SDK and parser must resolve their declared peers from a clean install. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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

function x509ImplementationDigest(owner) {
  const packageRoot = dirname(
    realpathSync(owner.resolve("@peculiar/x509/package.json")),
  );
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const entry = join(packageRoot, manifest.module ?? manifest.main);
  return createHash("sha256").update(readFileSync(entry)).digest("hex");
}

it("resolves each XML signature peer at its pinned compatible version", () => {
  const sdk = createRequire(core.resolve("xmldsigjs"));
  expect(version(sdk, "xml-core")).toBe("3.1.0");
  expect(version(sdk, "asn1js")).toBe("4.0.0");
  expect(version(sdk, "pkijs")).toBe("4.0.1");
});

it("shares the certificate parser and ASN.1 registry with WebAuthn", () => {
  const workspaceSchema = realpathSync(
    workspace.resolve("@peculiar/asn1-schema"),
  );
  expect(version(workspace, "@peculiar/asn1-schema")).toBe("3.0.0");

  const coreSchema = realpathSync(core.resolve("@peculiar/asn1-schema"));
  expect(version(core, "@peculiar/asn1-schema")).toBe("3.0.0");
  expect(workspaceSchema).toBe(coreSchema);

  expect(version(core, "@peculiar/x509")).toBe("3.1.0");
  expect(realpathSync(core.resolve("@peculiar/x509"))).toBe(
    realpathSync(workspace.resolve("@peculiar/x509")),
  );

  const upstream = createRequire(
    resolve(root, "packages/auth-upstream/package.json"),
  );
  const simplewebauthn = createRequire(
    workspace.resolve("@simplewebauthn/server"),
  );
  const coreDigest = x509ImplementationDigest(core);
  expect(version(simplewebauthn, "@peculiar/x509")).toBe("3.1.0");
  expect(x509ImplementationDigest(simplewebauthn)).toBe(coreDigest);
  expect(version(simplewebauthn, "@peculiar/asn1-schema")).toBe("3.0.0");
  expect(version(simplewebauthn, "asn1js")).toBe("4.0.0");
  expect(version(core, "asn1js")).toBe("4.0.0");

  expect(version(upstream, "asn1js")).toBe("4.0.0");

  const registry = realpathSync(core.resolve("asn1js"));
  expect(realpathSync(upstream.resolve("asn1js"))).toBe(registry);
  expect(realpathSync(simplewebauthn.resolve("asn1js"))).toBe(registry);

  for (const name of [
    "@peculiar/x509",
    "@peculiar/asn1-rsa",
    "@peculiar/asn1-x509",
    "@peculiar/asn1-ecc",
  ]) {
    const coreOwner = createRequire(core.resolve(name));
    const workspaceOwner = createRequire(workspace.resolve(name));
    expect(realpathSync(workspace.resolve(name)), name).toBe(
      realpathSync(core.resolve(name)),
    );
    expect(version(coreOwner, "@peculiar/asn1-schema"), name).toBe("3.0.0");
    expect(version(coreOwner, "asn1js"), name).toBe("4.0.0");
    expect(
      realpathSync(workspaceOwner.resolve("@peculiar/asn1-schema")),
      name,
    ).toBe(realpathSync(coreOwner.resolve("@peculiar/asn1-schema")));
    expect(realpathSync(workspaceOwner.resolve("asn1js")), name).toBe(
      realpathSync(coreOwner.resolve("asn1js")),
    );
  }
});
