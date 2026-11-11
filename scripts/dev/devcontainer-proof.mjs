#!/usr/bin/env node
// Builds the dev container and runs its whole setup under the settings
// .devcontainer/devcontainer.json declares, then checks the result.
//
//   node scripts/dev/devcontainer-proof.mjs          # needs a Docker daemon
//
// The container is started with the declared run arguments (every Linux
// capability dropped, no new privileges), as the declared user, with the
// declared environment, and runs the four lifecycle commands in the order an
// editor runs them. A command that needs a privilege the settings remove
// fails here, before a person opens the container.
//
// The repository is mounted read-only and copied inside the container, so the
// run cannot change the checkout it was started from. Nothing is pushed or
// published, and the image is removed afterwards.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = "/mnt/source";
// Where an editor puts the checkout: under /workspaces, outside $HOME, so mise
// never takes a personal ~/.config/mise for a project config while walking up.
const WORKSPACE = "/workspaces/OpenSesame";
const LIFECYCLE = [
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
];
// What must be true once setup has finished, as shell.
const CHECKS = [
  'test "$(id -un)" = "$EXPECTED_USER"',
  "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
  "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
  "node --version",
  "npm --version",
  "cargo --version",
  "test -d node_modules/.bin",
  'test "$(git config core.hooksPath)" = .githooks',
];

/** The shell the container runs: copy the source, set up, then check. */
export function script(config) {
  const commands = LIFECYCLE.map((name) => config[name]).filter(Boolean);
  if (!commands.every(isString))
    throw new Error("lifecycle commands must be strings");
  return [
    "set -euo pipefail",
    `cp -R ${SOURCE} ${WORKSPACE}`,
    `cd ${WORKSPACE}`,
    // Each in its own subshell: with `set -e`, a failure inside an `a && b`
    // list is otherwise ignored unless it is the last command of the list.
    ...commands.map((command) => `( ${command} )`),
    ...CHECKS,
    "echo devcontainer-proof: setup completed under the declared settings",
  ].join("\n");
}

/** The docker commands, as argument lists, for a parsed devcontainer.json. */
export function plan(config, { image, workspace }) {
  const { build, runArgs, containerUser, containerEnv } = config;
  if (!build?.dockerfile || !containerUser || !Array.isArray(runArgs))
    throw new Error(
      "devcontainer.json must declare build.dockerfile, containerUser and runArgs",
    );
  const directory = resolve(workspace, ".devcontainer");
  const environment = Object.entries(containerEnv ?? {}).flatMap(
    ([name, value]) => ["--env", `${name}=${value}`],
  );
  return {
    build: [
      "build",
      "--file",
      resolve(directory, build.dockerfile),
      "--tag",
      image,
      resolve(directory, build.context ?? "."),
    ],
    run: [
      "run",
      "--rm",
      ...runArgs,
      "--user",
      containerUser,
      ...environment,
      "--env",
      `EXPECTED_USER=${containerUser}`,
      "--volume",
      `${workspace}:${SOURCE}:ro`,
      // A scratch /workspaces the non-root user can write, gone with the run.
      "--mount",
      "type=tmpfs,destination=/workspaces,tmpfs-mode=1777",
      image,
      "bash",
      "-lc",
      script(config),
    ],
    remove: ["image", "rm", "--force", image],
  };
}

function docker(args) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const config = JSON.parse(
    readFileSync(resolve(root, ".devcontainer/devcontainer.json"), "utf8"),
  );
  const steps = plan(config, {
    image: `opensesame-devcontainer-proof:${process.pid}`,
    workspace: root,
  });
  const built = docker(steps.build);
  if (built !== 0) return built;
  try {
    return docker(steps.run);
  } finally {
    docker(steps.remove);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main());
