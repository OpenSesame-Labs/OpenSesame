/** Build the production SAML adapter with Pages chunking, then run it in a clean realm. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { bundleChunk } from "./bundle-chunk.mjs";
import {
  resolveXmldsigjsPeerDependencies,
  samlBrowserCrypto,
} from "./saml-browser-crypto.mjs";

const entry = "\0saml-fresh-runtime-entry";
const child = `
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
if (typeof Reflect.getMetadata !== "undefined") throw new Error("realm already has reflection metadata");
const dom = new JSDOM("<!doctype html><html></html>");
Object.defineProperty(dom.window, "crypto", { value: webcrypto });
for (const name of ["window", "self", "document", "DOMParser", "XMLSerializer", "Node", "NodeFilter", "XPathResult", "Event", "CustomEvent"])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "self" ? dom.window : dom.window[name] });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const input = JSON.parse(readFileSync(0, "utf8"));
const api = await import(pathToFileURL(process.argv[1]).href);
const owner = { signal: new AbortController().signal, assertCurrent() {} };
const metadata = await api.readSamlIdpMetadata(input.xml, "urn:adapter:idp", owner);
if (metadata.signingSpki.length !== 1 || metadata.signingSpki[0] !== input.spki)
  throw new Error("SAML metadata did not yield the expected trusted key");
if (metadata.postUrl !== "https://idp.example/sso") throw new Error("unexpected SAML endpoint");
if (typeof Reflect.getMetadata !== "function") throw new Error("reflection metadata was not installed");
dom.window.close();
process.stdout.write("fresh-saml-ok");
`;

export async function verifyFreshSamlRuntime(root, directory, xml, spki) {
  const core = resolve(root, "packages/app-core");
  const output = join(directory, "fresh-saml-chunks");
  const owned = ["xml-signature", "metadata", "authn-request"]
    .map(
      (name) =>
        `export * from ${JSON.stringify(resolve(core, `src/browser/saml/${name}.ts`))};`,
    )
    .join("\n");
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      resolveXmldsigjsPeerDependencies(root),
      {
        name: "fresh-saml-runtime-entry",
        resolveId(id) {
          return id === entry ? entry : null;
        },
        load(id) {
          return id === entry ? owned : null;
        },
      },
      samlBrowserCrypto(root),
    ],
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: "esbuild",
      target: "es2022",
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: "allow-extension",
        output: {
          format: "es",
          // Match Pages' execution-order protection for cross-chunk cycles.
          strictExecutionOrder: true,
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [
              { name: bundleChunk, includeDependenciesRecursively: false },
            ],
          },
        },
      },
    },
  });
  const chunks = result.output.filter((item) => item.type === "chunk");
  const main = chunks.find((item) => item.isEntry);
  if (!main || !chunks.some((item) => item.name === "reflect-metadata"))
    throw new Error("SAML reflection chunk was not built");
  writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
  const resultInFreshProcess = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", child, join(output, main.fileName)],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      input: JSON.stringify({ xml, spki }),
      timeout: 30000,
    },
  );
  if (resultInFreshProcess.status !== 0)
    throw new Error(
      `Fresh SAML runtime failed: ${resultInFreshProcess.stderr} ${resultInFreshProcess.error}`,
    );
  if (resultInFreshProcess.stdout !== "fresh-saml-ok")
    throw new Error("Fresh SAML runtime did not complete");
  return join(output, main.fileName);
}
