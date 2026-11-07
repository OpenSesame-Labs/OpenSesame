/** Pin-closed browser substitution: official XMLDSIG/C14N plus one shared X.509 parser. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pins = {
  packageSHA256:
    "974eca0002cf8b1ebee2be042ffa633b058b95a0c7676987471105845211911a",
  esmSHA256: "e75f7a75cc41a2286b0eebc0f8a459ccb7ac643c4d551f5163125eb4481f5aba",
  applicationSHA256:
    "b3bd8776a9da2d2b10ffaf1ba9d82911b0bdd818abe2b0dda50d18b209f14c82",
  certificateSHA256:
    "9e3d49e49a2536323106b5d21266eca2e51431facfe031e774f7ce302dc1032d",
  callers: {
    "xml-signature.ts":
      "3c86a7cad9651b8236bae7650e4afac65650d7dfaa35fcbd47269e00549d499d",
    "metadata.ts":
      "cf769479e584bde73d764d53d3cd9e85baeaa0c49eb54d9af0966b22f079ce49",
    "authn-signature.ts":
      "93697352444301d5ea45422fbf6fa87ba7987e875083f8aa593ad47d0a89674d",
    "xml-policy.ts":
      "745558c6a3677342c746243c4ae2c60189938759f60e3a9f4729467186da6d3e",
  },
  esmFiles: 42,
  xmldsigjsVersion: "3.0.0",
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const implementationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const saml = "packages/app-core/src/browser/saml";
function match(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`SAML browser crypto pin mismatch: ${label}`);
}
function inventory(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? inventory(path, base)
        : entry.name.endsWith(".js")
          ? [
              {
                path: relative(base, path).replaceAll("\\", "/"),
                // Pins are content hashes; a checkout may materialize the
                // sources with platform line endings (core.autocrlf), so
                // hash the LF-normalized bytes.
                sha256: sha(
                  readFileSync(path, "utf8").replaceAll("\r\n", "\n"),
                ),
              },
            ]
          : [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Dependency resolution belongs to app-core, never an arbitrary peer package. */
export function readSamlBrowserCryptoInputs(root) {
  const owner = createRequire(resolve(root, "packages/app-core/package.json"));
  const metadata = realpathSync(owner.resolve("xmldsigjs/package.json"));
  const packageSource = readFileSync(metadata, "utf8");
  match(sha(packageSource), pins.packageSHA256, "package");
  const parsed = JSON.parse(packageSource);
  match(parsed.name, "xmldsigjs", "package name");
  match(parsed.version, pins.xmldsigjsVersion, "version");
  const moduleEntry = parsed.module ?? parsed.main;
  const esm = resolve(dirname(metadata), dirname(moduleEntry)).replaceAll(
    "\\",
    "/",
  );
  match(
    sha(JSON.stringify(inventory(esm))),
    pins.esmSHA256,
    "complete SDK call surface",
  );
  const callers = Object.entries(pins.callers).map(([name, hash]) => {
    const path = resolve(root, saml, name);
    // Repo-checkout sources may carry platform line endings; hash LF bytes
    // as the pins do.
    match(sha(readFileSync(path, "utf8").replaceAll("\r\n", "\n")), hash, name);
    // Rollup module ids use `/` on every platform.
    return path.replaceAll("\\", "/");
  });
  const x509Path = realpathSync(owner.resolve("@peculiar/x509"));
  const x509Root = resolve(dirname(x509Path), "..");
  match(
    sha(readFileSync(resolve(x509Root, "package.json"))),
    "62e7ee55bc254005f6ac592930804213880b0fc0f62e43bb8a34d7573f1b71f8",
    "shared certificate package",
  );
  const x509Package = JSON.parse(
    readFileSync(resolve(x509Root, "package.json"), "utf8"),
  );
  const x509Module = x509Package.module ?? x509Package.main;
  const sharedCertificate = resolve(x509Root, x509Module);
  match(
    sha(readFileSync(sharedCertificate)),
    "3c4b3557e06a494350243a9064d16a1b1aecda4863b81cba8b6ba4706cad613a",
    "shared certificate implementation",
  );
  const reflectionOwner = createRequire(sharedCertificate);
  const reflection = {
    full: realpathSync(reflectionOwner.resolve("reflect-metadata")),
    lite: realpathSync(reflectionOwner.resolve("reflect-metadata/lite")),
  };
  const reflectionPackage = readFileSync(
    resolve(dirname(reflection.full), "package.json"),
  );
  match(
    sha(reflectionPackage),
    "e0f6d5cf809e02e338f501d3030e917fa57e3a10044387de890cbf142b4f4083",
    "reflection package",
  );
  match(
    sha(readFileSync(reflection.full)),
    "515c16dcde7492755691e3fca9eeca4656f1819b6e3307ecd4b0deaa93ad21e2",
    "reflection default implementation",
  );
  match(
    sha(readFileSync(reflection.lite)),
    "92d7537f2c9416514356dc386763a0284cf856a1771c2570bfd9d4e7eced3826",
    "reflection lite implementation",
  );
  const reflectionExports = JSON.parse(reflectionPackage);
  match(reflectionExports.version, "0.2.2", "reflection version");
  match(
    reflectionExports.exports["./lite"].default,
    "./ReflectLite.js",
    "official lite export",
  );
  const application = resolve(esm, "application.js").replaceAll("\\", "/");
  const certificate = resolve(esm, "pki/x509.js").replaceAll("\\", "/");
  const replacements = new Map([
    [
      application,
      resolve(implementationRoot, saml, "xml-crypto-application.ts").replaceAll(
        "\\",
        "/",
      ),
    ],
    [
      certificate,
      resolve(implementationRoot, saml, "xml-crypto-certificate.ts").replaceAll(
        "\\",
        "/",
      ),
    ],
  ]);
  return {
    esm,
    packageRoot: resolve(esm, "..").replaceAll("\\", "/"),
    sharedCertificate: sharedCertificate.replaceAll("\\", "/"),
    reflection: {
      full: reflection.full.replaceAll("\\", "/"),
      lite: reflection.lite.replaceAll("\\", "/"),
    },
    callers: callers.slice(0, 3),
    replacements,
    application,
    certificate,
  };
}

function assertAdapterConsumers(context, input) {
  for (const [sdkPath, adapter] of input.replacements) {
    const adapterInfo = context.getModuleInfo(adapter);
    const allowed =
      sdkPath === input.application
        ? [sdkPath, input.replacements.get(input.certificate)]
        : [sdkPath];
    if (
      !adapterInfo ||
      [...adapterInfo.importers, ...adapterInfo.dynamicImporters].some(
        (id) => !allowed.includes(id),
      )
    )
      throw new Error("Unexpected browser XMLDSIG adapter consumer");
  }
}

function assertSdkConsumers(context, input, entry, ids) {
  const sdkRoot = input.packageRoot;
  const normalizedEntry = entry.replaceAll("\\", "/");
  for (const id of ids) {
    const clean = id.replaceAll("\\", "/");
    if (clean.includes("/node_modules/xmldsigjs/") && !clean.startsWith(`${sdkRoot}/`))
      throw new Error("Unexpected browser XMLDSIG package instance");
    if (clean.startsWith(`${input.esm}/`) && clean !== normalizedEntry) {
      const module = context.getModuleInfo(id);
      const consumers = [...module.importers, ...module.dynamicImporters];
      if (
        consumers.some(
          (consumer) => !consumer.replaceAll("\\", "/").startsWith(`${input.esm}/`),
        )
      )
        throw new Error("Unexpected browser XMLDSIG consumer");
    }
  }
}

/** xmldsigjs 3 lists xml-core as a peer; app-core owns the pin. */
export function resolveXmldsigjsPeerDependencies(root) {
  const appCore = resolve(root, "packages/app-core/package.json");
  return {
    name: "saml-xmldsigjs-peer-resolver",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source !== "xml-core") return null;
      const normalizedImporter = importer?.replaceAll("\\", "/") ?? "";
      if (!normalizedImporter.includes("/node_modules/xmldsigjs/")) return null;
      const resolved = await this.resolve(source, appCore, { skipSelf: true });
      return resolved?.id ?? null;
    },
  };
}

/** No global package aliases: only the exact pinned SDK modules change their implementation. */
export function samlBrowserCrypto(root) {
  let input;
  const transformed = new Set();
  return {
    name: "saml-shared-browser-crypto",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readSamlBrowserCryptoInputs(root);
      transformed.clear();
    },
    async resolveId(source, importer) {
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const peer = await resolveXmldsigjsPeerDependencies(root).resolveId.call(
        this,
        source,
        importer,
      );
      if (peer) return peer;
      if (source !== "reflect-metadata") return null;
      const original = await this.resolve(source, importer, { skipSelf: true });
      // A side-effect import. Without the flag, code-splitting can drop the
      // lite polyfill from the @peculiar/x509 chunk and tsyringe throws.
      return original?.id === input.reflection.full
        ? { id: input.reflection.lite, moduleSideEffects: true }
        : null;
    },
    transform(source, id) {
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const replacement = input.replacements.get(id);
      if (!replacement) return null;
      match(
        sha(source),
        id === input.application
          ? pins.applicationSHA256
          : pins.certificateSHA256,
        "transform source",
      );
      transformed.add(id);
      return {
        code: `export * from ${JSON.stringify(replacement)};`,
        map: null,
      };
    },
    generateBundle() {
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const entry = resolve(input.esm, "index.js").replaceAll("\\", "/");
      const info = this.getModuleInfo(entry);
      if (!info) {
        match(transformed.size, 0, "unowned transformation");
        return;
      }
      const importers = [...info.importers, ...info.dynamicImporters];
      if (
        !importers.length ||
        importers.some((id) => !input.callers.includes(id))
      )
        throw new Error("Unexpected browser XMLDSIG consumer");
      match(transformed.size, 2, "both SDK wrappers");
      assertAdapterConsumers(this, input);
      const ids = [...this.getModuleIds()];
      assertSdkConsumers(this, input, entry, ids);
      if (!ids.includes(input.sharedCertificate))
        throw new Error(
          "SAML browser lost the shared official certificate parser",
        );
      if (
        ids.some((id) =>
          /\/node_modules\/(?:pkijs|bytestreamjs)\//.test(
            id.replaceAll("\\", "/"),
          ),
        )
      )
        throw new Error("SAML browser retained a second certificate engine");
      for (const name of ["signed_xml.js", "canonicalizer.js"])
        if (!ids.includes(resolve(input.esm, name).replaceAll("\\", "/")))
          throw new Error("SAML browser lost the official XML verifier");
    },
  };
}
