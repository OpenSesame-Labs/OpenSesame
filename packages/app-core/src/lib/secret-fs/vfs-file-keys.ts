/** Map ordinary stored files to their VFS keys. */
import { BODY_PATH, TOMBS_REGISTRY_KEY } from "../vfs.js";
import { SETTINGS_DIR, configFileFor, isPlainPath } from "./config-docs.js";
import { SecretFsRejected } from "./errors.js";
import { SECRETS_DIR } from "./layout.js";
import { LEGACY_BODY_FILE, MANIFEST_FILE } from "./secret-docs.js";

export const TOMBS_FILE = "tombs.json";
export const bodyKey = (tomb: string) => `tomb/${tomb}/${BODY_PATH}`;
const TOMB_KEY = /^tomb\/([^/]+)\/(.+)$/;

type Location =
  | Readonly<{ kind: "file"; file: string; path: string }>
  | Readonly<{ kind: "body"; tomb: string }>;

export const rejected = (path: string, reason: string) =>
  new SecretFsRejected({ path, kind: "invalid-path", reason });

/** The file a VFS key is stored in, or why it cannot be. */
export function locate(key: string): Location {
  if (key === TOMBS_REGISTRY_KEY)
    return { kind: "file", file: TOMBS_FILE, path: TOMBS_REGISTRY_KEY };
  const [, tomb, path] = TOMB_KEY.exec(key) ?? [];
  if (!tomb || !path) throw rejected(key, "is not a vault file");
  if (path === BODY_PATH) return { kind: "body", tomb };
  if (
    path === "vault" ||
    path === "secrets" ||
    path.startsWith(`${SECRETS_DIR}/`) ||
    path.startsWith(`${SETTINGS_DIR}/`)
  )
    throw rejected(key, "is a name the secret layout keeps for itself");
  const file = isPlainPath(path) ? `${path}.json` : configFileFor(path);
  return { kind: "file", file: `${tomb}/${file}`, path };
}

export function locatable(key: string): Location | null {
  try {
    return locate(key);
  } catch {
    return null;
  }
}

export function keyOfFile(
  path: string,
): { key: string; flatBody: string | null } | null {
  if (path === TOMBS_FILE) return { key: TOMBS_REGISTRY_KEY, flatBody: null };
  const [head, ...rest] = path.split("/");
  const rel = rest.join("/");
  if (!head) return null;
  if (rel === LEGACY_BODY_FILE) return { key: bodyKey(head), flatBody: head };
  if (
    rel.endsWith(".json") &&
    rel !== MANIFEST_FILE &&
    !rel.startsWith(`${SECRETS_DIR}/`)
  ) {
    return {
      key: `tomb/${head}/${rel.slice(0, -".json".length)}`,
      flatBody: null,
    };
  }
  return null;
}
