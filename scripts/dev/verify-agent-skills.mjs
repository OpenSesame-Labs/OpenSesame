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

function filesBelow(root, current = root, found = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) filesBelow(root, path, found);
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Unsupported entry in installed skill: ${path}`);
  }
  return found;
}

export function skillFolderHash(root) {
  const hash = createHash("sha256");
  for (const path of filesBelow(root).sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  )) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function containedBy(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function verifyInstalledSkills({ repo, installed, quarantine }) {
  const lock = JSON.parse(readFileSync(join(repo, "skills-lock.json"), "utf8"));
  const expected = new Map(
    Object.entries(lock.skills).map(([name, entry]) => [
      name.replace("stitch::", "stitch-"),
      entry.computedHash,
    ]),
  );
  const firstParty = realpathSync(join(repo, "skills"));
  const rejected = [];
  if (!lstatSync(installed, { throwIfNoEntry: false })?.isDirectory()) {
    return rejected;
  }
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    const path = join(installed, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = realpathSync(path);
        if (
          containedBy(firstParty, target) &&
          lstatSync(target).isDirectory() &&
          existsSync(join(target, "SKILL.md"))
        ) {
          continue;
        }
      } catch {
        // A broken or unreadable link is unverified and is quarantined below.
      }
    }
    let digest;
    try {
      digest = entry.isDirectory() ? skillFolderHash(path) : undefined;
    } catch {
      // Unsupported entries (including nested links) cannot be authenticated.
    }
    if (digest === expected.get(entry.name)) continue;
    rejected.push(entry.name);
    if (quarantine) {
      mkdirSync(quarantine, { recursive: true });
      const base = join(quarantine, `${entry.name}-${digest ?? "unknown"}`);
      let destination = base;
      for (let suffix = 1; existsSync(destination); suffix += 1) {
        destination = `${base}-${suffix}`;
      }
      renameSync(path, destination);
    }
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
