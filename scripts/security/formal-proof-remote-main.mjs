import { TextDecoder } from "node:util";
import { hasControl } from "./formal-proof-push-gate-registry.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

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
