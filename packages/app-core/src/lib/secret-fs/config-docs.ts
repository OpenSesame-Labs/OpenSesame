/**
 * The vault's other sealed files as readable files (ADR 0182): the settings and
 * extension state the VFS keeps beside the body — a page's preferences, a
 * transport, a drive pairing, a connector's settings. Each is one declarative
 * document with its VFS path and language on the outside and the sealed text
 * on the inside, at the address its Settings page shows it under where it has
 * one (`settings/live/transport.json`) and under `config/` where it does not.
 *
 * The seal is the VFS's own, bound to the tomb and the VFS path, so a document
 * moved to another name is still refused by the file it belongs to. The path in
 * the envelope is what says which VFS file it is; the file name is a label.
 * A value that is not a sealed blob (a header, a marker) is not wrapped and is
 * stored as the text it is.
 */
import type { SealedBlob } from "@opensesame/vault-core";
import { Schema } from "effect";
import { z } from "zod";

export const CONFIG_FORMAT = "opensesame.config";

const Languages = z.enum(["json", "yaml", "toml"]);
export type ConfigLanguage = z.infer<typeof Languages>;
const SealedConfig = z.object({ ivB64: z.string(), ctB64: z.string() });

/** `spec/secret-files/config-file.schema.json` is generated from this. */
function makeConfigSchema() {
  return Schema.Struct({
    format: Schema.Literal(CONFIG_FORMAT),
    version: Schema.Literal(1),
    path: Schema.String,
    language: Schema.Literals(["json", "yaml", "toml"]),
    sealed: Schema.Struct({ ivB64: Schema.String, ctB64: Schema.String }),
  });
}

// Keep the exported schema API while letting browser builds remove it when
// only the runtime reader is imported. The two readers are checked for parity.
export const ConfigDoc = /* @__PURE__ */ makeConfigSchema();

const RuntimeConfigDoc = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(1),
  path: z.string(),
  language: Languages,
  sealed: SealedConfig,
});

function parseJson<T>(value: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** VFS files whose text is read before the vault opens, and so is never sealed. */
const PLAIN = new Set(["header", "migrated.v1", "seal-bound.v1"]);

/** Where a Settings page shows a VFS file, when it shows it as a file of its own. */
const SETTINGS_ADDRESS = new Map<string, string>([
  ["config/prefs.source.yaml", "settings/prefs.yaml"],
  ["config/live-transport", "settings/live/transport.json"],
  [
    "config/item-types/marketplaces.json",
    "settings/item-types/marketplaces.json",
  ],
]);

export const SETTINGS_DIR = "settings";

export const isPlainPath = (path: string) => PLAIN.has(path);

export function languageOf(path: string): ConfigLanguage {
  if (/\.ya?ml$/.test(path)) return "yaml";
  if (/\.toml$/.test(path)) return "toml";
  return "json";
}

/** The file (inside the vault's directory) a VFS path is kept in. */
export function configFileFor(path: string): string {
  const address = SETTINGS_ADDRESS.get(path) ?? path;
  return address.endsWith(".json") ? address : `${address}.json`;
}

/** The envelope for a sealed value, or `null` when the value is not one. */
export function encodeConfig(path: string, value: string): Uint8Array | null {
  const sealed = parseJson(value, SealedConfig);
  if (sealed === null) return null;
  const doc: z.infer<typeof RuntimeConfigDoc> = {
    format: CONFIG_FORMAT,
    version: 1,
    path,
    language: languageOf(path),
    sealed,
  };
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}

export type DecodedConfig = Readonly<{ path: string; value: string }>;

/** The VFS path and sealed text a config document holds, or `null` for any other file. */
export function decodeConfig(bytes: Uint8Array): DecodedConfig | null {
  const doc = parseJson(new TextDecoder().decode(bytes), RuntimeConfigDoc);
  return doc === null
    ? null
    : {
        path: doc.path,
        value: JSON.stringify(doc.sealed satisfies SealedBlob),
      };
}
