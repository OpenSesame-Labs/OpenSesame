#!/usr/bin/env node
/**
 * Expected `docker inspect` fields for OpenSesame images.
 * Prints JSON. Does not call docker.
 *
 *   node scripts/ci/oci-image-config.mjs
 */
import { pathToFileURL } from "node:url";

export const IMAGE_SOURCE = "https://github.com/OpenSesame-Labs/OpenSesame";
export const ENV_DOCUMENTATION = `${IMAGE_SOURCE}/blob/main/docs/operators/ghcr-images.md`;
export const DEFAULT_VERSION = "0.0.0-local";

/** OCI labels shared by every hostable image. `version` is the built default. */
export function imageLabels(title, version = DEFAULT_VERSION) {
  return {
    "org.opencontainers.image.source": IMAGE_SOURCE,
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.licenses": "MIT",
    "org.opencontainers.image.title": title,
    "dev.opensesame.env.documentation": ENV_DOCUMENTATION,
  };
}

/**
 * Normalized contract for the native host image after
 * `docker build -f ops/compose/Dockerfile` with no VERSION build-arg.
 */
export function expectedImages() {
  const opensesame = {
    repository: "ghcr.io/opensesame-labs/opensesame",
    dockerfile: "ops/compose/Dockerfile",
    user: "10001",
    exposedPorts: ["8787/tcp"],
    entrypoint: ["opensesame"],
    volumes: ["/var/lib/opensesame"],
    env: {
      OPENSESAME_STATE_DIR: "/var/lib/opensesame",
      OPENSESAME_LISTEN: "0.0.0.0:8787",
      OPENSESAME_ALLOW_NONLOCAL: "1",
    },
    healthcheck: {
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8787/health/live"],
    },
    labels: imageLabels("opensesame"),
  };
  return { opensesame };
}

/** Shape a `docker inspect` Config object uses for the fields this repo pins. */
export function dockerInspectConfig(image) {
  return {
    User: image.user,
    Entrypoint: image.entrypoint,
    ExposedPorts: Object.fromEntries(
      image.exposedPorts.map((port) => [port, {}]),
    ),
    Volumes: Object.fromEntries(image.volumes.map((path) => [path, {}])),
    Labels: image.labels,
    Healthcheck: image.healthcheck
      ? { Test: image.healthcheck.test }
      : undefined,
  };
}

export function expectedInspect() {
  const images = expectedImages();
  return Object.fromEntries(
    Object.entries(images).map(([name, image]) => [
      name,
      { ...image, dockerInspect: dockerInspectConfig(image) },
    ]),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${JSON.stringify(expectedInspect(), null, 2)}\n`);
}
