import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

/** Only the CLI prepared by the integrity-pinned fetch step can publish. */
export function npmCli() {
  const cli = process.env.OPENSESAME_NPM_CLI;
  const temp = process.env.RUNNER_TEMP;
  if (!cli || !temp || !isAbsolute(cli) || !isAbsolute(temp)) {
    throw new Error("verified npm CLI path is required");
  }
  const parts = relative(temp, cli).split(sep);
  if (
    parts.length !== 5 ||
    !/^opensesame-npm-[A-Za-z0-9]{8}$/u.test(parts[0]) ||
    parts.slice(1).join("/") !== "extracted/package/bin/npm-cli.js"
  ) {
    throw new Error("verified npm CLI path is required");
  }
  try {
    if (!lstatSync(cli).isFile()) throw new Error();
  } catch {
    throw new Error("verified npm CLI path is required");
  }
  return cli;
}

/** A private cwd, home, and explicit configs prevent project/user config inheritance. */
export function createNpmContext(root, registry = NPM_REGISTRY) {
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const anonymous = join(root, "anonymous.npmrc");
  const authenticated = join(root, "authenticated.npmrc");
  const global = join(root, "global.npmrc");
  const url = new URL(registry);
  const base = `registry=${url.href}\n@opensesame-labs:registry=${url.href}\n`;
  const auth = `//${url.host}${url.pathname}:_authToken=\${NODE_AUTH_TOKEN}\n`;
  writeFileSync(anonymous, base, { flag: "wx", mode: 0o600 });
  writeFileSync(authenticated, base + auth, { flag: "wx", mode: 0o600 });
  writeFileSync(global, "", { flag: "wx", mode: 0o600 });
  return {
    cwd,
    home,
    anonymous,
    authenticated,
    global,
    registry: url.href,
    cache: join(root, "cache"),
  };
}

const COMMON_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const PROVENANCE_ENV = [
  "GITHUB_ACTIONS",
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_EVENT_NAME",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "RUNNER_ENVIRONMENT",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];

/** Public lookups and packing have no publication credential or OIDC authority. */
export function npmEnvironment(context, publish = false, source = process.env) {
  const env = {};
  for (const key of [...COMMON_ENV, ...(publish ? PROVENANCE_ENV : [])]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  if (publish && source.NODE_AUTH_TOKEN)
    env.NODE_AUTH_TOKEN = source.NODE_AUTH_TOKEN;
  return {
    ...env,
    HOME: context.home,
    NPM_CONFIG_USERCONFIG:
      publish && env.NODE_AUTH_TOKEN
        ? context.authenticated
        : context.anonymous,
    NPM_CONFIG_GLOBALCONFIG: context.global,
    NPM_CONFIG_CACHE: context.cache,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
}

/** --prefix fixes project config to our empty cwd, even if an ancestor has a package. */
export function npmConfigArgs(context) {
  return [
    "--prefix",
    context.cwd,
    "--registry",
    context.registry,
    "--ignore-scripts",
  ];
}
