#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject } from "../lib/json-boundary.mjs";

function entriesBelow(root, current = root, found = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      found.push({ path, type: 2 });
      entriesBelow(root, path, found);
    } else if (entry.isFile()) found.push({ path, type: 1 });
    else throw new Error(`Unsupported entry in installed skill: ${path}`);
  }
  return found;
}

function lengthPrefix(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function portablePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (value !== value.normalize("NFC")) {
    throw new Error(`Non-canonical Unicode path in installed skill: ${value}`);
  }
  return value;
}

export function skillTreeHashV2(root) {
  const entries = entriesBelow(root).map(({ path, type }) => ({
    path,
    type,
    relative: portablePath(root, path),
  }));
  entries.sort((a, b) =>
    Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)),
  );
  const insensitive = new Set();
  for (const { relative: name } of entries) {
    const folded = name.toLowerCase();
    if (insensitive.has(folded)) {
      throw new Error(`Case-colliding paths in installed skill: ${name}`);
    }
    insensitive.add(folded);
  }

  const hash = createHash("sha256");
  hash.update("OpenSesame skill tree\0v2\0");
  hash.update(lengthPrefix(entries.length));
  for (const { path, relative: name, type } of entries) {
    const nameBytes = Buffer.from(name);
    // Modes are intentionally excluded: catalogue copies cross filesystems
    // that do not preserve POSIX mode bits. Entry type, every path and every
    // regular-file byte are authenticated; links and special files fail.
    const contents = type === 1 ? readFileSync(path) : Buffer.alloc(0);
    hash.update(Buffer.from([type]));
    hash.update(lengthPrefix(nameBytes.length));
    hash.update(nameBytes);
    hash.update(lengthPrefix(contents.length));
    hash.update(contents);
  }
  return hash.digest("hex");
}

function containedBy(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expectedSkills(repo) {
  const lock = JSON.parse(readFileSync(join(repo, "skills-lock.json"), "utf8"));
  if (
    lock.integrity?.algorithm !== "opensesame-skill-tree-v2" ||
    !lock.skills ||
    !isJsonObject(lock.skills)
  ) {
    throw new Error("skills lock has no supported integrity catalogue");
  }
  return new Map(
    Object.entries(lock.skills).map(([name, entry]) => {
      if (!/^[0-9a-f]{64}$/u.test(entry.treeHashV2 ?? "")) {
        throw new Error(`skills lock has no valid tree hash for ${name}`);
      }
      return [name.replace("stitch::", "stitch-"), entry.treeHashV2];
    }),
  );
}

function isFirstPartySkillLink(entry, path, firstParty) {
  if (!entry.isSymbolicLink()) return false;
  try {
    const target = realpathSync(path);
    return (
      containedBy(firstParty, target) &&
      lstatSync(target).isDirectory() &&
      existsSync(join(target, "SKILL.md"))
    );
  } catch {
    return false;
  }
}

function installedSkillDigest(entry, path) {
  try {
    return entry.isDirectory() ? skillTreeHashV2(path) : undefined;
  } catch {
    return undefined;
  }
}

function quarantineSkill(path, quarantine, name, digest) {
  mkdirSync(quarantine, { recursive: true });
  const base = join(quarantine, `${name}-${digest ?? "unknown"}`);
  let destination = base;
  for (let suffix = 1; existsSync(destination); suffix += 1) {
    destination = `${base}-${suffix}`;
  }
  renameSync(path, destination);
}

export function verifyInstalledSkills({ repo, installed, quarantine }) {
  const expected = expectedSkills(repo);
  const firstParty = realpathSync(join(repo, "skills"));
  const rejected = [];
  if (!lstatSync(installed, { throwIfNoEntry: false })?.isDirectory()) {
    return rejected;
  }
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    const path = join(installed, entry.name);
    if (isFirstPartySkillLink(entry, path, firstParty)) continue;
    const digest = installedSkillDigest(entry, path);
    if (digest === expected.get(entry.name)) continue;
    rejected.push(entry.name);
    if (quarantine) quarantineSkill(path, quarantine, entry.name, digest);
  }
  return rejected;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const repo = resolve(process.env.OPENSESAME_SKILLS_REPO ?? ".");
  const installed = resolve(
    process.env.OPENSESAME_SKILLS_ROOT ?? join(repo, ".agents/skills"),
  );
  const quarantine = args.has("--quarantine")
    ? resolve(
        process.env.OPENSESAME_SKILLS_QUARANTINE ??
          join(repo, ".agents/quarantine"),
      )
    : undefined;
  const rejected = verifyInstalledSkills({ repo, installed, quarantine });
  if (rejected.length > 0) {
    console.error(
      `Unverified agent skills ${quarantine ? "quarantined" : "found"}: ${rejected.join(", ")}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
