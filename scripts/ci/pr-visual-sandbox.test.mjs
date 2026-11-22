import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "$DOCKER_TEST_LOG"
stage=''; profile=''; dist=''
for arg in "$@"; do
  case "$arg" in
    /repo/apps/pages/scripts/security-profile.mjs) stage=profile ;;
    /repo/node_modules/vite/bin/vite.js) stage=build ;;
    type=bind,source=*,target=/repo/apps/pages/public/security-profile.json)
      profile="\${arg#type=bind,source=}"
      profile="\${profile%,target=/repo/apps/pages/public/security-profile.json}" ;;
    type=bind,source=*,target=/repo/apps/pages/dist)
      dist="\${arg#type=bind,source=}"
      dist="\${dist%,target=/repo/apps/pages/dist}" ;;
  esac
done
if [ "$stage" = profile ]; then
  printf 'generated-profile' > "$profile"
elif [ "$stage" = build ]; then
  [ "$(cat "$profile")" = generated-profile ]
  printf '<html>' > "$dist/index.html"
fi
`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-visual-sandbox-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const runner = path.join(root, "runner");
  const bin = path.join(root, "bin");
  const trusted = path.join(workspace, "base");
  const change = path.join(workspace, "head");
  for (const dir of [
    runner,
    bin,
    ...["apps", "packages", "examples", "tests", "tools"].map((p) =>
      path.join(trusted, p),
    ),
    path.join(trusted, "node_modules"),
    path.join(trusted, "packages/app-core/node_modules"),
    path.join(trusted, "tests/fuzz/jazzer/node_modules"),
    path.join(trusted, ".cache/pwa-tailscale-native-http/distributions"),
    path.join(trusted, "scripts/ci"),
    path.join(change, "apps/pages/public"),
  ])
    mkdirSync(dir, { recursive: true });
  const safety = path.join(trusted, "scripts/ci/pr-visual-safety.mjs");
  writeFileSync(safety, readFileSync(path.join(here, "pr-visual-safety.mjs")));
  writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
  const log = path.join(root, "docker-args");
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runner,
    PR_VISUAL_BASE_SHA: "a".repeat(40),
    PR_VISUAL_HEAD_SHA: "b".repeat(40),
    PR_VISUAL_NODE_BINARY: process.execPath,
    DOCKER_TEST_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  };
  return {
    root,
    runner,
    bin,
    trusted,
    change,
    safety,
    log,
    env,
    script: path.join(here, "pr-visual-sandbox.sh"),
    profile: path.join(change, "apps/pages/public/security-profile.json"),
  };
}

function run(f, mode, env = f.env) {
  return spawnSync("bash", [f.script, mode], { env, encoding: "utf8" });
}

function assertHeadMounts(args, f) {
  assert.ok(
    args.includes(
      `type=bind,source=${process.execPath},target=/usr/bin/node,readonly`,
    ),
  );
  assert.ok(
    !args.some((arg) =>
      arg.startsWith(`type=bind,source=${path.dirname(process.execPath)},`),
    ),
  );
  for (const value of [
    "/usr/bin/node",
    "/repo/apps/pages/scripts/security-profile.mjs",
    "mcr.microsoft.com/playwright@sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366",
    "--network",
    "none",
    "--user",
    "--cap-drop",
    "ALL",
    "--read-only",
    "no-new-privileges",
    `type=bind,source=${f.change},target=/repo,readonly`,
    `type=bind,source=${f.runner}/pr-visual/head-security-profile.json,target=/repo/apps/pages/public/security-profile.json`,
  ])
    assert.ok(args.includes(value), value);
  for (const nested of [
    "packages/app-core/node_modules",
    "tests/fuzz/jazzer/node_modules",
  ])
    assert.ok(
      args.includes(
        `type=bind,source=${f.trusted}/${nested},target=/repo/${nested},readonly`,
      ),
    );
  assert.ok(
    args.some((arg) =>
      arg.includes(
        "/pwa-tailscale-native-http/distributions,target=/repo/.cache/pwa-tailscale-native-http/distributions,readonly",
      ),
    ),
  );
  assert.ok(!args.some((arg) => /docker\.sock|TOKEN/u.test(arg)));
}

test("head build isolates dependencies and generates its profile before Vite", (t) => {
  const f = fixture(t);
  symlinkSync(f.root, f.profile);
  const linked = run(f, "head");
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /sandbox path traverses a link/u);
  rmSync(f.profile);
  writeFileSync(f.profile, "{}");
  const result = run(f, "head");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.profile, "utf8"), "{}");
  assert.equal(
    readFileSync(
      path.join(f.runner, "pr-visual/head-security-profile.json"),
      "utf8",
    ),
    "generated-profile",
  );
  assertHeadMounts(readFileSync(f.log, "utf8").split("\0"), f);
});

test("the sandbox rejects another Node version and linked head paths", (t) => {
  const f = fixture(t);
  const wrongNode = path.join(f.bin, "node-wrong-version");
  writeFileSync(wrongNode, "#!/bin/sh\nprintf 22\n", { mode: 0o755 });
  const wrong = run(f, "head", { ...f.env, PR_VISUAL_NODE_BINARY: wrongNode });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /expected Node 24/u);
  rmSync(path.join(f.change, "apps"), { recursive: true });
  symlinkSync(f.root, path.join(f.change, "apps"));
  const linked = run(f, "head");
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /sandbox path traverses a link/u);
});

test("capture exposes only the trusted controller and read-only distributions", (t) => {
  const f = fixture(t);
  writeFileSync(f.safety, "");
  symlinkSync(f.root, path.join(f.trusted, "work"));
  const linked = run(f, "capture");
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /capture path traverses a link/u);
  rmSync(path.join(f.trusted, "work"));
  const result = run(f, "capture");
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(f.log, "utf8").split("\0");
  assert.ok(
    args.includes(`type=bind,source=${f.trusted},target=/repo,readonly`),
  );
  for (const side of ["base", "head"])
    assert.ok(
      args.includes(
        `type=bind,source=${f.runner}/pr-visual/${side}-dist,target=/visual/${side},readonly`,
      ),
    );
  assert.ok(!args.some((arg) => arg.includes(`source=${f.change},`)));
  assert.ok(!args.some((arg) => /docker\.sock|TOKEN/u.test(arg)));
});

test("dependency discovery fails before Docker if a source tree is missing", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.trusted, "apps/pages/public"), { recursive: true });
  writeFileSync(
    path.join(f.trusted, "apps/pages/public/security-profile.json"),
    "{}",
  );
  rmSync(path.join(f.trusted, "examples"), { recursive: true });
  writeFileSync(f.log, "");
  const result = run(f, "base");
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.log, "utf8"), "");
});

test("dependency paths cannot inject Docker mount options", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.trusted, "packages/unsafe,name/node_modules"), {
    recursive: true,
  });
  writeFileSync(f.profile, "{}");
  writeFileSync(f.log, "");
  const result = run(f, "head");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe dependency path/u);
  assert.equal(readFileSync(f.log, "utf8"), "");
});
