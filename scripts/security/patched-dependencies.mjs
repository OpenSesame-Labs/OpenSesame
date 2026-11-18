// scripts/security/patched-dependencies.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { x as extractTar, t as listTar } from "tar";

var root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var MANIFEST = "patches/vendor/manifest.json";
function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
function integrity(file) {
  const digest = createHash("sha512").update(readFileSync(file));
  return `sha512-${digest.digest("base64")}`;
}
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A temporary directory may sit inside some other checkout. Git must treat
    // the extracted package as plain files, not as paths of that repository.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
}
function fail(selector, detail) {
  throw new Error(`${selector}: ${detail}`);
}
function assertPackageEntries(tarball) {
  const entries = [];
  listTar({
    file: tarball,
    sync: true,
    strict: true,
    onentry: (entry) => entries.push({ type: entry.type, name: entry.path }),
  });
  if (entries.length === 0)
    throw new Error(`${tarball}: unreadable tarball listing`);
  for (const { type, name } of entries) {
    const inside =
      name.startsWith("package/") && !name.split("/").includes("..");
    if (!inside || !["File", "Directory"].includes(type))
      throw new Error(`${tarball}: refused entry ${JSON.stringify(name)}`);
  }
}
function extract(tarball, into) {
  assertPackageEntries(tarball);
  mkdirSync(into, { recursive: true });
  extractTar({ file: tarball, cwd: into, sync: true, strict: true });
  return join(into, "package");
}
function fileMap(directory) {
  const files = /* @__PURE__ */ Object.create(null);
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const digest = createHash("sha256").update(readFileSync(path));
        files[relative(directory, path)] = digest.digest("hex");
      }
    }
  };
  walk(directory);
  return files;
}
function fileMapIntegrity(files) {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(files).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
function patchApplies(packageDirectory, patch, reverse) {
  const args = ["apply", "--check", "-p1", "--whitespace=nowarn"];
  if (reverse) args.push("-R");
  try {
    run("git", [...args, join(root, patch)], packageDirectory);
    return true;
  } catch {
    return false;
  }
}
function applyPatch(packageDirectory, patch, reverse = false) {
  const args = ["apply", "-p1", "--whitespace=nowarn"];
  if (reverse) args.push("-R");
  run("git", [...args, join(root, patch)], packageDirectory);
}
function lastLine(text) {
  return text.trim().split("\n").at(-1);
}
function buildPatched(selector, entry, work) {
  const upstreamDirectory = join(work, "upstream");
  const output = join(work, "out");
  mkdirSync(upstreamDirectory, { recursive: true });
  mkdirSync(output, { recursive: true });
  const download = [
    "pack",
    entry.upstreamTarball ?? selector,
    "--ignore-scripts",
    "--silent",
  ];
  const upstream = join(
    upstreamDirectory,
    lastLine(
      run("npm", [...download, "--pack-destination", upstreamDirectory], work),
    ),
  );
  if (integrity(upstream) !== entry.upstreamIntegrity)
    fail(selector, "upstream tarball integrity drift");
  const source = extract(upstream, join(work, "source"));
  if (
    entry.upstreamFileMapSha256 !== undefined &&
    fileMapIntegrity(fileMap(source)) !== entry.upstreamFileMapSha256
  )
    fail(selector, "reviewed upstream source map drift");
  applyPatch(source, entry.patch);
  const pack = ["pack", "--ignore-scripts", "--silent"];
  const packed = run("npm", [...pack, "--pack-destination", output], source);
  return join(output, lastLine(packed));
}
function differingFiles(expected, actual) {
  const paths = /* @__PURE__ */ new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ]);
  return [...paths]
    .filter(
      (path) =>
        !Object.hasOwn(expected, path) ||
        !Object.hasOwn(actual, path) ||
        expected[path] !== actual[path],
    )
    .sort();
}
function installedPackageDifferences(expected, actual, packagePath, packages) {
  const prefix = `${packagePath}/node_modules/`;
  const children = Object.keys(packages)
    .filter((key) => key.startsWith(prefix))
    .map((key) => `${key.slice(packagePath.length + 1)}/`);
  const owned = /* @__PURE__ */ Object.create(null);
  for (const [path, value] of Object.entries(actual)) {
    const normalized = path.replaceAll("\\", "/");
    if (
      !Object.hasOwn(expected, path) &&
      children.some((child) => normalized.startsWith(child))
    )
      continue;
    owned[path] = value;
  }
  return differingFiles(expected, owned);
}
function pinLockfile(selector, tarball, value) {
  const at = selector.lastIndexOf("@");
  const name = selector.slice(0, at);
  const version = selector.slice(at + 1);
  const path = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(path, "utf8"));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (
      (!key.endsWith(`node_modules/${name}`) && entry.name !== name) ||
      entry.version !== version
    )
      continue;
    entry.resolved = `file:${tarball}`;
    entry.integrity = value;
  }
  writeFileSync(
    path,
    `${JSON.stringify(lock, null, 2)}
`,
  );
}
function build(selector, entry, work) {
  const built = buildPatched(selector, entry, work);
  copyFileSync(built, join(root, entry.tarball));
  pinLockfile(selector, entry.tarball, integrity(built));
  console.log(`${selector}: wrote ${entry.tarball}`);
}
function verify(selector, entry, work) {
  const built = fileMap(extract(buildPatched(selector, entry, work), work));
  const committed = fileMap(
    extract(join(root, entry.tarball), join(work, "committed")),
  );
  const differing = differingFiles(built, committed);
  if (differing.length > 0)
    fail(selector, `rebuilt files differ: ${differing.join(", ")}`);
  const count = Object.keys(committed).length;
  console.log(`${selector}: ${count} files equal upstream plus patch`);
}
function verifyOffline(selector, entry, work) {
  const committed = join(root, entry.tarball);
  const source = extract(committed, join(work, "source"));
  const committedFiles = fileMap(source);
  if (!patchApplies(source, entry.patch, true))
    fail(selector, "the reviewed patch cannot be reversed");
  applyPatch(source, entry.patch, true);
  if (fileMapIntegrity(fileMap(source)) !== entry.upstreamFileMapSha256)
    fail(selector, "reverse-patched source differs from reviewed upstream");
  if (!patchApplies(source, entry.patch, false))
    fail(selector, "the reviewed patch cannot be reapplied");
  applyPatch(source, entry.patch);
  if (fileMapIntegrity(fileMap(source)) !== fileMapIntegrity(committedFiles))
    fail(selector, "upstream plus patch differs from committed source");
  console.log(`${selector}: offline upstream and patched artifacts reproduced`);
}
function main(mode, selected) {
  const action = { build, verify, "verify-offline": verifyOffline }[mode];
  if (!action) {
    console.error(
      "Usage: node scripts/security/patched-dependencies.mjs build|verify|verify-offline [package@version]",
    );
    process.exit(2);
  }
  const entries = Object.entries(readJson(MANIFEST).vendored).filter(
    ([selector]) => selected === undefined || selector === selected,
  );
  if (entries.length === 0) {
    fail(selected, "no vendored dependency manifest entry");
  }
  for (const [selector, entry] of entries) {
    const work = mkdtempSync(join(tmpdir(), "opensesame-patched-"));
    try {
      action(selector, entry, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv[2], process.argv[3]);

function npmCommandShim() {
  const bin = dirname(process.execPath);
  const paths = [
    process.env.npm_execpath,
    join(bin, "node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
    ...String(process.env.PATH ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .flatMap((dir) => [
        join(dir, "node_modules/npm/bin/npm-cli.js"),
        resolve(dir, "../lib/node_modules/npm/bin/npm-cli.js"),
      ]),
  ];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    const executable = realpathSync(path);
    const shim = resolve(dirname(executable), "../node_modules/cmd-shim");
    if (existsSync(shim)) return createRequire(executable)(shim);
  }
  throw new Error(
    "Cannot locate the active npm cmd-shim to verify Windows bins",
  );
}
function directChildren(packagePath, packages) {
  const prefix = `${packagePath}/node_modules/`;
  return Object.entries(packages).flatMap(([key, entry]) => {
    if (!key.startsWith(prefix)) return [];
    const name = key.slice(prefix.length);
    if (
      !/^(?:@[^/]+\/)?[^/\\]+$/.test(name) ||
      name.split("/").some((part) => part === "." || part === "..") ||
      entry.link
    )
      return [];
    if (!entry.bin || typeof entry.bin !== "object") return [];
    return Object.entries(entry.bin).map(([bin, target]) => ({
      name,
      bin,
      target,
    }));
  });
}
function validTarget(directory, child, bin, target) {
  if (!bin || bin === "." || bin === ".." || /[/\\\0]/.test(bin)) return null;
  if (typeof target !== "string" || isAbsolute(target)) return null;
  const childRoot = resolve(directory, "node_modules", child);
  const file = resolve(childRoot, target);
  const inside = relative(childRoot, file);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    return null;
  return file;
}
function isCorrectLink(link, target) {
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) return false;
  return resolve(dirname(link), readlinkSync(link)) === target;
}
async function matchingWindowsShims(directory, child, bin, target, shim) {
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-npm-bin-"));
  try {
    const targetInPackage = relative(
      join(directory, "node_modules", child),
      target,
    );
    const source = join(scratch, "node_modules", child, targetInPackage);
    const generated = join(scratch, "node_modules", ".bin", bin);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, readFileSync(target));
    await shim(source, generated);
    const actual = join(directory, "node_modules", ".bin", bin);
    return ["", ".cmd", ".ps1"].every((suffix) => {
      const path = `${actual}${suffix}`;
      return (
        existsSync(path) &&
        lstatSync(path).isFile() &&
        readFileSync(path).equals(readFileSync(`${generated}${suffix}`))
      );
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function installedNpmBins(
  directory,
  packagePath,
  packages,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const verified = /* @__PURE__ */ new Set();
  for (const { name, bin, target } of directChildren(packagePath, packages)) {
    const file = validTarget(directory, name, bin, target);
    if (!file) continue;
    const base = `node_modules/.bin/${bin}`;
    if (!existsSync(join(directory, base))) continue;
    if (platform === "win32") {
      if (
        await matchingWindowsShims(
          directory,
          name,
          bin,
          file,
          options.shim ?? npmCommandShim(),
        )
      )
        for (const suffix of ["", ".cmd", ".ps1"])
          verified.add(`${base}${suffix}`);
    } else if (isCorrectLink(join(directory, base), file)) {
      verified.add(base);
    }
  }
  return verified;
}
function withoutVerifiedNpmBins(expected, actual, bins) {
  const owned = Object.assign(/* @__PURE__ */ Object.create(null), actual);
  for (const path of Object.keys(owned)) {
    if (!Object.hasOwn(expected, path) && bins.has(path.replaceAll("\\", "/")))
      delete owned[path];
  }
  return owned;
}

export {
  MANIFEST,
  applyPatch,
  assertPackageEntries,
  buildPatched,
  differingFiles,
  extract,
  fileMap,
  fileMapIntegrity,
  installedNpmBins,
  installedPackageDifferences,
  integrity,
  npmCommandShim,
  patchApplies,
  readJson,
  root,
  verifyOffline,
  withoutVerifiedNpmBins,
};
