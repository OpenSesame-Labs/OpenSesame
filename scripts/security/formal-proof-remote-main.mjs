import { TextDecoder } from "node:util";
import { hasControl } from "./formal-proof-push-gate-registry.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function pushDestination(root, remote, git, exact = false) {
  if (!remote || hasControl(remote))
    throw new Error(
      "A push destination is required to inspect formal proof policy",
    );
  const names = decoder
    .decode(git(root, ["remote"]))
    .split("\n")
    .filter(Boolean);
  if (!names.includes(remote)) return remote;
  if (exact)
    throw new Error("Ambiguous push destination; use an explicit URL or path");
  const urls = decoder
    .decode(git(root, ["remote", "get-url", "--push", "--all", "--", remote]))
    .split("\n")
    .filter(Boolean);
  if (urls.length > 1)
    throw new Error(
      "Multiple push destinations require an explicit URL or path",
    );
  if (urls.length !== 1 || !urls[0] || hasControl(urls[0]))
    throw new Error("Cannot resolve the push destination");
  if (names.includes(urls[0]))
    throw new Error("Ambiguous push destination; use an explicit URL or path");
  return urls[0];
}

function advertisedMain(root, remote, git) {
  const lines = decoder
    .decode(git(root, ["ls-remote", "--refs", "--", remote, "refs/heads/main"]))
    .split("\n")
    .filter(Boolean);
  if (!lines.length) return null;
  const fields = lines[0].split("\t");
  if (
    lines.length !== 1 ||
    fields.length !== 2 ||
    !objectId.test(fields[0]) ||
    fields[1] !== "refs/heads/main"
  )
    throw new Error("Malformed remote main ref advertisement");
  return fields[0];
}

export function remoteMain(root, remote, { git, hasObject, commit }) {
  if (!remote || hasControl(remote))
    throw new Error("A remote is required to inspect its formal proof policy");
  const oid = advertisedMain(root, remote, git);
  if (!oid) return null;
  if (!hasObject(root, oid)) {
    git(root, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--filter=blob:none",
      "--",
      remote,
      "refs/heads/main",
    ]);
    if (advertisedMain(root, remote, git) !== oid)
      throw new Error(
        "The remote main ref changed while inspecting the push; retry.",
      );
  }
  if (!hasObject(root, oid))
    throw new Error(
      "The remote main ref changed while inspecting the push; retry.",
    );
  const target = commit(root, oid);
  if (!target) throw new Error("The remote main ref is not a commit");
  return target;
}
