import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { plan, script } from "../dev/devcontainer-proof.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** Effective key=value settings of an npmrc, ignoring comments. */
function npmrc(text) {
  const settings = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#"))
      settings[match[1]] = match[2];
  }
  return settings;
}

/** Command lines that run `npm ci` or `npm install`, and those lacking the flag. */
function unflaggedInstalls(text) {
  const commands = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))
    .filter((line) => /(^|[\s;&|])npm (ci|install)(\s|$)/.test(line));
  return {
    count: commands.length,
    unflagged: commands.filter((line) => !line.includes("--ignore-scripts")),
  };
}

describe("dependency install policy", () => {
  it("never runs a dependency's lifecycle script", () => {
    expect(npmrc(read(".npmrc"))).toEqual({
      "ignore-scripts": "true",
      "save-exact": "true",
    });
  });

  it("is not undone by a root or workspace install hook", () => {
    const hooks = ["preinstall", "install", "postinstall", "prepare"];
    const manifest = JSON.parse(read("package.json"));
    for (const hook of hooks)
      expect(manifest.scripts[hook], hook).toBeUndefined();
  });

  it("passes --ignore-scripts on every install that may not see .npmrc", () => {
    // Most CI jobs use a sparse checkout that leaves .npmrc out, and an image
    // build sees only its own context, so the flag is explicit everywhere.
    const workflows = readdirSync(new URL(".github/workflows/", root))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`);
    const installers = [
      ...workflows,
      ".github/actions/publish-npm-package/action.yml",
      "ops/containers/cli/Dockerfile",
      "ops/containers/control-plane/Dockerfile",
      "ops/containers/web-pwa/Dockerfile",
    ];
    expect(workflows.length).toBeGreaterThan(30);
    let installs = 0;
    for (const path of installers) {
      const found = unflaggedInstalls(read(path));
      installs += found.count;
      expect(found.unflagged, path).toEqual([]);
    }
    expect(installs).toBeGreaterThan(30);
  });

  it("flags an install without the flag and skips comments", () => {
    const text = [
      "run: npm ci",
      "  # npm ci is pinned",
      "RUN npm ci --omit=dev --ignore-scripts",
      "run: npm install left-pad",
      "run: npm run build",
    ].join("\n");
    expect(unflaggedInstalls(text).unflagged).toEqual([
      "run: npm ci",
      "run: npm install left-pad",
    ]);
  });

  it("reads a commented-out setting as absent", () => {
    expect(npmrc("# ignore-scripts=true\nsave-exact = true\n")).toEqual({
      "save-exact": "true",
    });
  });
});

describe("dev container", () => {
  const config = JSON.parse(read(".devcontainer/devcontainer.json"));
  const dockerfile = read(".devcontainer/Dockerfile");

  it("runs as a non-root user that cannot gain privileges", () => {
    expect(config.containerUser).toBe("vscode");
    expect(config.remoteUser).toBe("vscode");
    expect(config.runArgs).toEqual([
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
    ]);
    expect(dockerfile.trimEnd().split("\n").at(-1)).toBe("USER vscode");
  });

  it("is not privileged and does not reach the host's Docker daemon", () => {
    const text = JSON.stringify(config);
    expect(config.privileged).toBeUndefined();
    expect(config.capAdd).toBeUndefined();
    expect(config.features).toBeUndefined();
    expect(text).not.toContain("docker.sock");
    expect(text).not.toContain("--privileged");
    expect(text).not.toContain("--cap-add");
  });

  it("builds from a digest-pinned base and pins every extension", () => {
    const bases = dockerfile.match(/^FROM .+$/gm);
    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatch(/^FROM \S+@sha256:[a-f0-9]{64}$/);
    const extensions = config.customizations.vscode.extensions;
    expect(extensions.length).toBeGreaterThan(0);
    for (const extension of extensions)
      expect(extension).toMatch(/^[\w.-]+@\d[\w.-]*$/);
  });

  it("carries no secret-shaped configuration", () => {
    const names = Object.keys(config.containerEnv ?? {});
    for (const name of names)
      expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY/i);
  });
});

describe("dev container toolchain install", () => {
  it("installs only the project's locked tools, whatever a personal config adds", () => {
    // The dotfiles bootstrap may write a personal ~/.config/mise/config.toml
    // with unpinned tools. A locked install that reads it refuses them and
    // the container comes up without a toolchain, so every locked install in
    // the lifecycle reads the project's pins and nothing else.
    const config = JSON.parse(read(".devcontainer/devcontainer.json"));
    const commands = [
      config.onCreateCommand,
      config.updateContentCommand,
      config.postCreateCommand,
      config.postStartCommand,
    ].join(" && ");
    const installs =
      commands.match(/(?:\S+=\S+ )*mise install --locked/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs)
      expect(install).toBe(
        'MISE_GLOBAL_CONFIG_FILE="$PWD/.devcontainer/mise-global.toml" mise install --locked',
      );
    // The stand-in must exist and declare nothing: mise reads a config's type
    // from its extension and refuses a path that is not a config file.
    const standIn = read(".devcontainer/mise-global.toml");
    expect(
      standIn.split("\n").filter((line) => /^\s*[^#\s]/.test(line)),
    ).toEqual([]);
  });
});

describe("dev container proof", () => {
  const config = JSON.parse(read(".devcontainer/devcontainer.json"));
  const steps = plan(config, { image: "proof:1", workspace: "/repo" });

  it("starts the container exactly as declared and mounts the source read-only", () => {
    expect(steps.build).toEqual([
      "build",
      "--file",
      "/repo/.devcontainer/Dockerfile",
      "--tag",
      "proof:1",
      "/repo/.devcontainer",
    ]);
    const run = steps.run;
    for (const argument of config.runArgs) expect(run).toContain(argument);
    expect(run[run.indexOf("--user") + 1]).toBe(config.containerUser);
    for (const [name, value] of Object.entries(config.containerEnv))
      expect(run).toContain(`${name}=${value}`);
    expect(run[run.indexOf("--volume") + 1]).toBe("/repo:/mnt/source:ro");
    // Nothing that would hand the container more than the declaration does.
    expect(run.join(" ")).not.toMatch(
      /--privileged|--cap-add|docker\.sock|--network[= ]host|--pid[= ]host/,
    );
    expect(run.slice(-3, -1)).toEqual(["bash", "-lc"]);
  });

  it("runs every lifecycle command in the editor's order, then checks the result", () => {
    const lines = script(config).split("\n");
    const at = (text) => lines.indexOf(text);
    const order = [
      config.onCreateCommand,
      config.updateContentCommand,
      config.postCreateCommand,
      config.postStartCommand,
    ].map((command) => at(`( ${command} )`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lines[0]).toBe("set -euo pipefail");
    const checks = lines.slice(order.at(-1) + 1).join("\n");
    expect(checks).toContain('test "$(id -un)" = "$EXPECTED_USER"');
    expect(checks).toContain("CapEff:[[:space:]]+0+$");
    expect(checks).toContain("NoNewPrivs:[[:space:]]+1$");
    expect(() => script({ postCreateCommand: ["a", "b"] })).toThrow(/strings/);
    // A failure anywhere in a command stops the run: bash ignores a failing
    // non-final member of an `&&` list under `set -e` unless it is isolated.
    const failing = script({ onCreateCommand: "false && true" }).replace(
      /^cp .*\n^cd .*\n/m,
      "",
    );
    const ran = spawnSync("bash", ["-c", `${failing}\necho reached`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, EXPECTED_USER: "nobody" },
    });
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).not.toContain("reached");
    expect(() =>
      plan({ runArgs: [] }, { image: "i", workspace: "/r" }),
    ).toThrow(/containerUser/);
  });

  it("runs on a pull request that changes the container, with a read-only token", () => {
    const workflow = parse(read(".github/workflows/devcontainer.yml"));
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.proof.permissions).toEqual({ contents: "read" });
    const paths = workflow.on.pull_request.paths;
    for (const path of [
      ".devcontainer/**",
      "mise.toml",
      "mise.lock",
      "scripts/dev/devcontainer-proof.mjs",
    ])
      expect(paths).toContain(path);
    // Every script a lifecycle command names starts the proof when it changes.
    const named = script(config).match(/scripts\/dev\/[\w.-]+\.sh/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) expect(paths).toContain(path);
    expect(workflow.jobs.proof.steps.at(-1).run).toBe(
      "node scripts/dev/devcontainer-proof.mjs",
    );
  });
});
