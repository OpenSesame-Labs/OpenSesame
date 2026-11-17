import { assertFilePath, assertTombName } from "./vfs-metadata-data.js";

export const HEADER_PATH = "header";

/** The storage key for a validated logical VFS path. */
export function tombFileKey(tomb: string, path: string): string {
  assertTombName(tomb);
  assertFilePath(path);
  return `tomb/${tomb}/${path}`;
}
