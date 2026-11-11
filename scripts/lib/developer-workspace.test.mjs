import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
