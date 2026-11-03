#!/usr/bin/env node
/**
 * Smoke-check local images when docker is installed.
 * Without docker, or with no image arguments, exit 0 and say why.
 *
 *   node scripts/ci/oci-image-smoke.mjs cli:local web-pwa:local
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Image name without registry, tag, or digest. */
export function imageLeaf(reference) {
  const withoutDigest = reference.split("@")[0] ?? reference;
  const base = withoutDigest.split("/").pop() ?? withoutDigest;
  return base.split(":")[0] ?? base;
}

/** How to probe one image. Control-plane curl is optional without operator env. */
export function probePlan(reference) {
  const leaf = imageLeaf(reference);
  if (leaf === "web-pwa") {
    return { kind: "http", port: 5180, path: "/", optional: false };
  }
  if (leaf === "control-plane") {
    return {
      kind: "http",
      port: 8788,
      path: "/v1/health/live",
      optional: true,
    };
  }
  return { kind: "version" };
}

export function dockerReady() {
  const ran = spawnSync("docker", ["version"], { encoding: "utf8" });
  return ran.status === 0;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

function probeVersion(reference) {
  const ran = spawnSync("docker", ["run", "--rm", reference, "--version"], {
    encoding: "utf8",
  });
  if (ran.status !== 0) {
    return fail(
      `oci-image-smoke: ${reference} --version failed\n${ran.stderr || ran.stdout}`,
    );
  }
  process.stdout.write(ran.stdout);
  return 0;
}

function hostPort(mapping) {
  const line = mapping
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  const port = line?.split(":").pop() ?? "";
  return /^\d+$/u.test(port) ? port : undefined;
}

function answersOk(port, path) {
  const ran = spawnSync(
    process.execPath,
    [
      "-e",
      `fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)}).then((response)=>process.exit(response.status===200?0:1)).catch(()=>process.exit(1))`,
    ],
    { encoding: "utf8" },
  );
  return ran.status === 0;
}

function probeHttp(reference, plan) {
  const name = `oci-smoke-${plan.port}-${process.pid}`;
  const started = spawnSync(
    "docker",
    ["run", "-d", "--name", name, "-p", `127.0.0.1::${plan.port}`, reference],
    { encoding: "utf8" },
  );
  const remove = () => {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
  };
  if (started.status !== 0) {
    remove();
    if (plan.optional) {
      process.stdout.write(
        `oci-image-smoke: ${reference} did not start; skip\n`,
      );
      return 0;
    }
    return fail(
      started.stderr || `oci-image-smoke: ${reference} did not start`,
    );
  }
  const mapped = spawnSync("docker", ["port", name, `${plan.port}/tcp`], {
    encoding: "utf8",
  });
  const port = hostPort(mapped.stdout);
  let ok = false;
  if (port !== undefined) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      spawnSync("sleep", ["0.5"]);
      if (answersOk(port, plan.path)) {
        ok = true;
        break;
      }
    }
  }
  remove();
  if (ok) {
    process.stdout.write(`oci-image-smoke: ${reference} HTTP 200\n`);
    return 0;
  }
  if (plan.optional) {
    process.stdout.write(
      `oci-image-smoke: ${reference} did not answer 200; skip (operator env required)\n`,
    );
    return 0;
  }
  return fail(`oci-image-smoke: ${reference} did not answer 200`);
}

export function smokeImages(references) {
  if (!dockerReady()) {
    process.stdout.write("oci-image-smoke: docker unavailable, skip\n");
    return 0;
  }
  if (references.length === 0) {
    process.stdout.write("oci-image-smoke: no image arguments, skip\n");
    return 0;
  }
  for (const reference of references) {
    const plan = probePlan(reference);
    const status =
      plan.kind === "version"
        ? probeVersion(reference)
        : probeHttp(reference, plan);
    if (status !== 0) return status;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = smokeImages(process.argv.slice(2));
}
