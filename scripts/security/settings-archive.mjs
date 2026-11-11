// Taking the previous settings record out of its artifact archive. No network.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FILE = "repository-settings.json";
// A record is a few kilobytes; its archive is refused well before memory is.
export const MAX_ARCHIVE_BYTES = 1024 * 1024;

/**
 * Unpacks the record, and only the record, from an artifact archive into
 * `directory`, and says whether there was one. An archive can carry a link in
 * the record's place, which reading would follow out of the directory, so
 * anything but a regular file is refused.
 */
export function extractRecord(directory, bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new Error("previous record archive is too large");
  mkdirSync(directory, { recursive: true });
  const zip = join(directory, "previous.zip");
  writeFileSync(zip, bytes);
  try {
    execFileSync("unzip", ["-o", "-q", zip, FILE, "-d", directory], {
      stdio: "ignore",
    });
  } catch (error) {
    // unzip exits 11 when the archive holds no such member.
    if (error.status === 11) return false;
    throw new Error("previous record archive is unreadable");
  }
  let entry;
  try {
    entry = lstatSync(join(directory, FILE));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!entry.isFile()) throw new Error("previous record is not a regular file");
  return true;
}
