import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINIMUM_SHARED_RUNNERS,
  hasRunnerMinimum,
  minimumForSuite,
  parseRunnerInventory,
} from "./formal-proof-runner-pins.mjs";

const productionInventory = parseRunnerInventory(
  readFileSync(new URL("./formal-proof-runner-pins.json", import.meta.url)),
);
const PINNED_FORMAL_RUNNERS = productionInventory.suites;
const SHARED_FORMAL_RUNNERS = productionInventory.shared;

export const script = fileURLToPath(
  new URL("./formal-proof-push-gate.mjs", import.meta.url),
);
export const nil = "0".repeat(40);
export const registry = {
  version: 1,
  suites: [
    {
      id: "a",
      implementation: ["src/a", "src/added"],
      proofs: ["spec/formal/a/proof"],
      command: ["npm", "run", "verify:a"],
    },
    {
      id: "b",
      implementation: ["src/b"],
      proofs: ["spec/formal/b/proof"],
      command: ["npm", "run", "verify:b"],
    },
  ],
};

function setupController(controller) {
  mkdirSync(join(controller, "security"), { recursive: true });
  mkdirSync(join(controller, "lib"));
  for (const name of [
    "formal-proof-push-gate.mjs",
    "formal-proof-push-gate-registry.mjs",
    "formal-proof-push-history.mjs",
    "formal-proof-lock-history.mjs",
    "formal-proof-runner-history.mjs",
    "formal-proof-runner-pins.mjs",
    "formal-proof-manifest-set.mjs",
    "formal-proof-source-selection.mjs",
    "formal-proof-spiffe-peer-domain.mjs",
    "formal-proof-source-history.mjs",
    "formal-proof-remote-main.mjs",
    "formal-proof-required-suites.mjs",
  ])
    writeFileSync(
      join(controller, "security", name),
      readFileSync(new URL(`./${name}`, import.meta.url)),
    );
  writeFileSync(
    join(controller, "lib/json-boundary.mjs"),
    readFileSync(new URL("../lib/json-boundary.mjs", import.meta.url)),
  );
}

function pinController(controller, repo, write) {
  return (policy) => {
    for (const suite of policy.suites) {
      if (
        hasRunnerMinimum(suite.id) &&
        Array.isArray(suite.proofs) &&
        !suite.proofs.some((path) => path.endsWith("/required-theorems.lean"))
      ) {
        const signature = PINNED_FORMAL_RUNNERS[suite.id].files.find((path) =>
          path.endsWith("/required-theorems.lean"),
        );
        suite.proofs = [...suite.proofs, signature];
      }
    }
    const contents = `export const PINNED_FORMAL_SUITES = ${JSON.stringify(policy.suites)};\n`;
    const formal = policy.suites.some(
      (suite) =>
        hasRunnerMinimum(suite.id) ||
        (Array.isArray(suite.proofs) &&
          suite.proofs.some((path) =>
            path.endsWith("/required-theorems.lean"),
          )),
    );
    const shared = formal
      ? [...MINIMUM_SHARED_RUNNERS, "scripts/test/shared-runner.sh"]
      : [".npmrc", "scripts/test/shared-runner.sh"];
    const suites = policy.suites.map((suite) => {
      const protectedSuite =
        Array.isArray(suite.proofs) &&
        (hasRunnerMinimum(suite.id) ||
          suite.proofs.some((path) =>
            path.endsWith("/required-theorems.lean"),
          ));
      const minimum = protectedSuite
        ? minimumForSuite(suite)
        : { files: [], cargoConfigDirs: [], optionalFiles: [] };
      return [
        "suite",
        suite.id,
        suite.command?.[2],
        [...new Set([`scripts/test/${suite.id}-runner.sh`, ...minimum.files])],
        minimum.cargoConfigDirs,
        minimum.optionalFiles,
      ];
    });
    const runnerContents = JSON.stringify([
      "formal-proof-runners-v1",
      ["shared", shared],
      ...suites,
    ]);
    writeFileSync(
      join(controller, "security/formal-proof-pinned-suites.mjs"),
      contents,
    );
    if (
      existsSync(join(repo, "scripts/security/formal-proof-pinned-suites.mjs"))
    )
      write("scripts/security/formal-proof-pinned-suites.mjs", contents);
    writeFileSync(
      join(controller, "security/formal-proof-runner-pins.json"),
      runnerContents,
    );
    write("scripts/security/formal-proof-runner-pins.json", runnerContents);
    for (const suite of policy.suites) {
      const path = `scripts/test/${suite.id}-runner.sh`;
      if (!existsSync(join(repo, path))) write(path, "#!/bin/sh\nexit 0\n");
    }
    if (!existsSync(join(repo, "scripts/test/shared-runner.sh")))
      write("scripts/test/shared-runner.sh", "#!/bin/sh\nexit 0\n");
    if (formal)
      for (const path of new Set([
        ...shared,
        ...suites.flatMap((row) => row[3]),
      ])) {
        if (path === "scripts/security/formal-proof-pinned-suites.mjs")
          write(path, contents);
        else if (!existsSync(join(repo, path)))
          write(path, readFileSync(new URL(`../../${path}`, import.meta.url)));
      }
  };
}

function setupFixtureFiles(write) {
  write(".npmrc", "ignore-scripts=true\n");
  write(
    "scripts/security/formal-proof-manifest-set.mjs",
    readFileSync(new URL("./formal-proof-manifest-set.mjs", import.meta.url)),
  );
  const scripts = {
    "verify:a": "bash scripts/test/a-runner.sh",
    "verify:b": "bash scripts/test/b-runner.sh",
    "verify:alternate": "bash scripts/test/a-runner.sh",
    "verify:spiffe": "bash scripts/test/spiffe-runner.sh",
  };
  for (const [id, runner] of Object.entries(PINNED_FORMAL_RUNNERS))
    scripts[runner.script] = `bash scripts/test/${id}-runner.sh`;
  write("package.json", JSON.stringify({ scripts }));
  for (const id of ["auth", "oauth", "webauthn", "authority", "dpop", "spiffe"])
    write(`scripts/test/${id}-runner.sh`, "#!/bin/sh\nexit 0\n");
  write("src/a", "a0\n");
  write("src/b", "b0\n");
  write("src/other", "other\n");
  write("spec/formal/a/proof", "a proof\n");
  write("spec/formal/b/proof", "b proof\n");
  write("spec/formal/proof-registry.json", JSON.stringify(registry));
  write("spec/formal/proof-requirements.json", JSON.stringify(registry));
}

export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "formal-push-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"),
    remote = join(dir, "remote.git"),
    controller = join(dir, "controller"),
    bin = join(dir, "bin"),
    log = join(dir, "commands");
  mkdirSync(repo);
  mkdirSync(bin);
  setupController(controller);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", remote);
  const write = (name, contents) => {
    const path = join(repo, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  // Each fixture has its own trusted controller. Tests may explicitly update
  // that controller when simulating a reviewed policy change.
  const pin = pinController(controller, repo, write);
  pin(registry);
  setupFixtureFiles(write);
  const commit = () => {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "change");
    return git("rev-parse", "HEAD");
  };
  const base = commit();
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  writeFileSync(
    join(bin, "npm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FORMAL_TEST_LOG"\ntest "$(cat src/a 2>/dev/null || true)" = "$(git show HEAD:src/a 2>/dev/null || true)" || exit 15\nif [ "${FORMAL_TEST_MUTATE:-0}" = 1 ]; then printf mutation >> src/b; fi\nexit "${FORMAL_TEST_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  const tuple = (target, previous = base, ref = "refs/heads/main") =>
    `${target === nil ? "(delete)" : "refs/heads/work"} ${target} ${ref} ${previous}\n`;
  const run = (input, extra = {}, remoteName = "origin") =>
    spawnSync(
      process.execPath,
      [join(controller, "security/formal-proof-push-gate.mjs"), remoteName],
      {
        cwd: repo,
        input,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FORMAL_TEST_LOG: log,
          ...extra,
        },
      },
    );
  const commands = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return {
    dir,
    repo,
    remote,
    controller,
    bin,
    log,
    git,
    write,
    pin,
    commit,
    base,
    tuple,
    run,
    commands,
  };
}

export function installHook(f) {
  f.write(
    ".githooks/pre-push",
    readFileSync(
      fileURLToPath(new URL("../../.githooks/pre-push", import.meta.url)),
    ),
  );
  f.write("scripts/security/formal-proof-push-gate.mjs", readFileSync(script));
  f.write(
    "scripts/security/formal-proof-push-gate-registry.mjs",
    readFileSync(
      fileURLToPath(
        new URL("./formal-proof-push-gate-registry.mjs", import.meta.url),
      ),
    ),
  );
  f.write(
    "scripts/security/formal-proof-required-suites.mjs",
    readFileSync(
      new URL("./formal-proof-required-suites.mjs", import.meta.url),
    ),
  );
  f.write(
    "scripts/security/formal-proof-push-history.mjs",
    readFileSync(new URL("./formal-proof-push-history.mjs", import.meta.url)),
  );
  for (const name of [
    "formal-proof-lock-history.mjs",
    "formal-proof-runner-history.mjs",
    "formal-proof-runner-pins.mjs",
    "formal-proof-manifest-set.mjs",
    "formal-proof-source-selection.mjs",
    "formal-proof-spiffe-peer-domain.mjs",
    "formal-proof-source-history.mjs",
    "cargo-lock-projection.py",
    "cargo-workspace-projection.py",
    "cargo-workspace-multipackage.py",
  ])
    f.write(
      `scripts/security/${name}`,
      readFileSync(new URL(`./${name}`, import.meta.url)),
    );
  f.write(
    "scripts/security/formal-proof-remote-main.mjs",
    readFileSync(new URL("./formal-proof-remote-main.mjs", import.meta.url)),
  );
  f.write(
    "scripts/security/formal-proof-pinned-suites.mjs",
    readFileSync(join(f.controller, "security/formal-proof-pinned-suites.mjs")),
  );
  f.write(
    "scripts/security/formal-proof-runner-pins.json",
    readFileSync(join(f.controller, "security/formal-proof-runner-pins.json")),
  );
  f.write(
    "scripts/lib/json-boundary.mjs",
    readFileSync(
      fileURLToPath(new URL("../lib/json-boundary.mjs", import.meta.url)),
    ),
  );
  f.write(
    "scripts/security/exposure-matrix-gate.mjs",
    "process.stdin.resume();\n",
  );
  chmodSync(join(f.repo, ".githooks/pre-push"), 0o755);
  f.commit();
}

export function push(f, source, destination, status = "0") {
  return spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=.githooks",
      "push",
      "--dry-run",
      "origin",
      `${source}:${destination}`,
    ],
    {
      cwd: f.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        FORMAL_TEST_LOG: f.log,
        FORMAL_TEST_STATUS: status,
        OPENSESAME_PREPUSH: "off",
      },
    },
  );
}

export function productionFixture(t, id, setup = () => {}) {
  const f = fixture(t);
  const suite = { ...registry.suites[0], id };
  suite.command = ["npm", "run", PINNED_FORMAL_RUNNERS[id].script];
  const policy = { version: 1, suites: [suite] };
  f.pin(policy);
  f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
  f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
  installHook(f);
  const root = new URL("../../", import.meta.url);
  const paths = [...SHARED_FORMAL_RUNNERS, ...PINNED_FORMAL_RUNNERS[id].files];
  for (const path of paths)
    if (!existsSync(join(f.repo, path)))
      f.write(path, readFileSync(new URL(path, root)));
  f.write(
    "scripts/security/formal-proof-runner-pins.json",
    readFileSync(new URL("./formal-proof-runner-pins.json", import.meta.url)),
  );
  setup(f);
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return f;
}
